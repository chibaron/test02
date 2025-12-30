const FLASH_BASE = 0x08000000;
const WRITE_CHUNK = 256; 
let port, reader, writer;

const logDiv = document.getElementById('log');

// --- ログ出力システム ---
function debugLog(message, type = 'info') {
    const span = document.createElement('span');
    const now = new Date().toLocaleTimeString('ja-JP', { hour12: false, fractionDigits: 3 });
    
    if (type === 'tx') span.className = 'tx';
    else if (type === 'rx') span.className = 'rx';
    else if (type === 'err') span.className = 'err';
    else if (type === 'success') span.className = 'success';

    span.textContent = `[${now}] ${message}\n`;
    logDiv.appendChild(span);
    logDiv.scrollTop = logDiv.scrollHeight;
}

// ログ消去
document.getElementById('clearLogBtn').onclick = () => logDiv.innerHTML = '';

// --- ユーティリティ ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function calcChecksum(uint8Array) {
    let cs = 0;
    for (let b of uint8Array) cs ^= b;
    return cs & 0xFF;
}

function msp_crc8_d5(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 0x80) crc = (crc << 1) ^ 0xD5;
            else crc <<= 1;
        }
    }
    return crc & 0xFF;
}

// --- シリアル通信 ---
async function writeData(data) {
    const arr = new Uint8Array(data);
    debugLog(`TX > ${Array.from(arr).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`, 'tx');
    await writer.write(arr);
}

async function readResponse(timeout = 2000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const { value, done } = await reader.read();
        clearTimeout(id);
        if (value) {
            debugLog(`RX < ${Array.from(value).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`, 'rx');
            return value;
        }
    } catch (e) {
        debugLog(`Read Timeout/Error: ${e}`, 'err');
    }
    return null;
}

// --- メイン処理 ---
document.getElementById('connectBtn').onclick = async () => {
    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        writer = port.writable.getWriter();
        reader = port.readable.getReader();
        debugLog("Serial Port Connected.", "success");
        document.getElementById('flashBtn').disabled = false;
    } catch (e) {
        debugLog(`Connection Failed: ${e}`, "err");
    }
};

document.getElementById('flashBtn').onclick = async () => {
    const fileInput = document.getElementById('hexFile');
    if (!fileInput.files.length) return alert("HEXファイルを選択してください");

    try {
        const file = fileInput.files[0];
        const hexText = await file.text();
        const firmware = parseHex(hexText);
        debugLog(`HEX Loaded: ${firmware.length} bytes found.`, "info");

        // 2. MSP Serial Passthrough
        debugLog("Step 2: Sending MSP Passthrough command...", "info");
        let mspPass = [0x24, 0x58, 0x3C, 0x00, 0xF5, 0x00, 0x02, 0x00, 0xFE, 0x11];
        mspPass.push(msp_crc8_d5(mspPass.slice(3, 10)));
        await writeData(mspPass);
        await sleep(1000);

        // 3. MSP Bootloader Start
        debugLog("Step 3: Sending MSP Bootloader Start command...", "info");
        let mspBoot = [0x24, 0x58, 0x3C, 0x00, 0x44, 0x00, 0x00, 0x00];
        mspBoot.push(msp_crc8_d5(mspBoot.slice(3, 8)));
        await writeData(mspBoot);
        await sleep(1000);

        // 4. Initialize / Sync
        debugLog("Step 4: Synchronizing with 0x7F...", "info");
        await writeData([0x7F]);
        let res = await readResponse();
        if (!res || res[0] !== 0x79) throw new Error("ACK(0x79) not received for Sync.");

        // 5. Get Device Info (GET ID)
        debugLog("Step 5: Getting Device ID...", "info");
        await writeData([0x02, 0xFD]);
        res = await readResponse();
        if (!res || res[0] !== 0x79) throw new Error("Failed to get ID.");

        // 6. Calculate & Erase (簡易的に 全消去コマンド 0x44 0xBB or Extended Erase)
        debugLog("Step 6: Erasing Flash...", "info");
        await writeData([0x44, 0xBB]); // Extended Erase command
        // 本来は消去範囲を送信する必要がありますが、Pythonコードに合わせ簡易化
        await writeData([0xFF, 0xFF, 0x00]); // Special Global Erase
        res = await readResponse(5000); // 消去は時間がかかる
        
        // 7. Write Firmware
        debugLog("Step 7: Writing Firmware...", "info");
        for (let i = 0; i < firmware.length; i += WRITE_CHUNK) {
            const chunk = firmware.slice(i, i + WRITE_CHUNK);
            const addr = FLASH_BASE + i;
            
            // A. Write Memory Command
            await writeData([0x31, 0xCE]);
            if ((await readResponse())[0] !== 0x79) throw new Error("Write Cmd NACK");

            // B. Send Address
            const addrBytes = new Uint8Array([
                (addr >> 24) & 0xFF, (addr >> 16) & 0xFF, (addr >> 8) & 0xFF, addr & 0xFF
            ]);
            await writeData([...addrBytes, calcChecksum(addrBytes)]);
            if ((await readResponse())[0] !== 0x79) throw new Error("Address NACK");

            // C. Send Data
            const lenByte = chunk.length - 1;
            const dataToSign = new Uint8Array([lenByte, ...chunk]);
            await writeData([...dataToSign, calcChecksum(dataToSign)]);
            if ((await readResponse())[0] !== 0x79) throw new Error("Data NACK");

            if (i % 1024 === 0) debugLog(`Progress: ${i} / ${firmware.length} bytes written...`);
        }

        debugLog("COMPLETED SUCCESSFULLY!", "success");

    } catch (e) {
        debugLog(`FATAL ERROR: ${e.message}`, "err");
    }
};

// Intel HEX 簡易パーサー
function parseHex(hex) {
    const lines = hex.split(/\r?\n/);
    let bin = [];
    for (let line of lines) {
        line = line.trim();
        if (!line.startsWith(':')) continue;
        const type = parseInt(line.substring(7, 9), 16);
        if (type === 0x00) { // Data Record
            const bytes = line.substring(9, line.length - 2).match(/.{1,2}/g).map(h => parseInt(h, 16));
            bin.push(...bytes);
        }
    }
    return new Uint8Array(bin);
}
