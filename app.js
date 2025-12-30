/* =========================================================
 * STM32 Web Flasher
 * Web Serial + MSP v2 + STM32 UART Bootloader
 * ========================================================= */

"use strict";

/* ===================== UI ===================== */

const hexInput  = document.getElementById("hexFile");
const btnConn   = document.getElementById("connect");
const btnStart  = document.getElementById("start");
const logEl     = document.getElementById("log");

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

/* ===================== Constants ===================== */

const BAUDRATE = 115200;

const ACK  = 0x79;
const NACK = 0x1F;

const FLASH_BASE = 0x08000000;
const PAGE_SIZE  = 2048;
const WRITE_CHUNK = 32;

/* ===================== Serial ===================== */

let port;
let reader;
let writer;

async function connectSerial() {
  port = await navigator.serial.requestPort();
  await port.open({ baudRate: BAUDRATE });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();

  log("Serial connected");
}

async function writeBytes(bytes) {
  await writer.write(new Uint8Array(bytes));
}

async function readByte(timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { value } = await reader.read();
    if (value && value.length) {
      return value[0];
    }
  }
  throw new Error("Read timeout");
}

async function waitAck() {
  const b = await readByte();
  if (b === ACK) return true;
  if (b === NACK) return false;
  throw new Error("Invalid response: " + b.toString(16));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ===================== MSP ===================== */

function mspCrc8D5(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0xD5) : (crc << 1);
      crc &= 0xFF;
    }
  }
  return crc;
}

async function sendMspFrame(payload) {
  await writeBytes(payload);
  log("MSP TX: " + payload.map(b => b.toString(16).padStart(2, "0")).join(" "));
}

async function mspPassthrough() {
  log("MSP: enable serial passthrough");
  const data = [
    0x24,0x58,0x3C,  // $X<
    0x00,245,0x00,0x02,0x00,0xFE,0x11
  ];
  data.push(mspCrc8D5(data.slice(3)));
  await sendMspFrame(data);
  await sleep(1000);
}

async function mspBootloaderStart() {
  log("MSP: bootloader start");
  const data = [
    0x24,0x58,0x3C, // $X<
    0x00,68,0x00,0x00,0x00
  ];
  data.push(mspCrc8D5(data.slice(3)));
  await sendMspFrame(data);
  await sleep(1000);
}

/* ===================== STM32 Bootloader ===================== */

async function blSync() {
  log("Bootloader sync");
  for (let i = 0; i < 5; i++) {
    await writeBytes([0x7F]);
    try {
      const r = await readByte(500);
      if (r === ACK) {
        log("Sync OK");
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("Sync failed");
}

async function blSendCmd(cmd) {
  await writeBytes([cmd, cmd ^ 0xFF]);
  return await waitAck();
}

function xorChecksum(buf) {
  return buf.reduce((a, b) => a ^ b, 0);
}

async function blGetID() {
  log("Get Device ID");
  if (!(await blSendCmd(0x02))) throw new Error("GET_ID failed");

  const n = await readByte();
  let pid = 0;
  for (let i = 0; i < n + 1; i++) {
    pid = (pid << 8) | await readByte();
  }
  await waitAck();
  log("PID: 0x" + pid.toString(16));
}

async function blErasePage(page) {
  if (!(await blSendCmd(0x44))) return false;

  const payload = [
    0x00, 0x00,
    (page >> 8) & 0xFF,
    page & 0xFF
  ];
  await writeBytes(payload);
  await writeBytes([xorChecksum(payload)]);
  return await waitAck();
}

async function blWrite(addr, data) {
  if (!(await blSendCmd(0x31))) return false;

  const addrBytes = [
    (addr >> 24) & 0xFF,
    (addr >> 16) & 0xFF,
    (addr >> 8) & 0xFF,
    addr & 0xFF
  ];
  await writeBytes(addrBytes);
  await writeBytes([xorChecksum(addrBytes)]);
  if (!(await waitAck())) return false;

  const payload = [data.length - 1, ...data];
  await writeBytes(payload);
  await writeBytes([xorChecksum(payload)]);
  return await waitAck();
}

/* ===================== Intel HEX ===================== */

function parseHex(text) {
  const mem = new Map();
  let base = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(":")) continue;

    const len  = parseInt(line.substr(1,2),16);
    const addr = parseInt(line.substr(3,4),16);
    const type = parseInt(line.substr(7,2),16);

    if (type === 0x04) {
      base = parseInt(line.substr(9,4),16) << 16;
    } else if (type === 0x00) {
      for (let i = 0; i < len; i++) {
        const v = parseInt(line.substr(9 + i*2, 2), 16);
        mem.set(base + addr + i, v);
      }
    }
  }
  return mem;
}

/* ===================== Flash Procedure ===================== */

async function flash(hexText) {
  const mem = parseHex(hexText);
  const addrs = [...mem.keys()];
  const minAddr = Math.min(...addrs);
  const maxAddr = Math.max(...addrs);

  log(`HEX range: 0x${minAddr.toString(16)} - 0x${maxAddr.toString(16)}`);

  const startPage = Math.floor((minAddr - FLASH_BASE) / PAGE_SIZE);
  const endPage   = Math.floor((maxAddr - FLASH_BASE) / PAGE_SIZE);

  log(`Erase pages: ${startPage} - ${endPage}`);

  for (let p = startPage; p <= endPage; p++) {
    if (!(await blErasePage(p)))
      throw new Error("Erase failed: page " + p);
    log(`Erased page ${p}`);
  }

  let addr = minAddr;
  while (addr <= maxAddr) {
    const chunk = [];
    for (let i = 0; i < WRITE_CHUNK; i++) {
      if (mem.has(addr)) chunk.push(mem.get(addr));
      else chunk.push(0xFF);
      addr++;
      if (addr > maxAddr) break;
    }
    if (!(await blWrite(addr - chunk.length, chunk)))
      throw new Error("Write failed");
    log(`Write 0x${(addr - chunk.length).toString(16)}`);
  }

  log("Flash completed");
}

/* ===================== UI Wiring ===================== */

btnConn.onclick = async () => {
  try {
    await connectSerial();
    btnStart.disabled = false;
  } catch (e) {
    log("Connect error: " + e);
  }
};

btnStart.onclick = async () => {
  try {
    const file = hexInput.files[0];
    if (!file) throw new Error("HEX not selected");

    const text = await file.text();

    await mspPassthrough();
    await mspBootloaderStart();

    await blSync();
    await blGetID();

    await flash(text);

    log("DONE");
  } catch (e) {
    log("ERROR: " + e.message);
  }
};
