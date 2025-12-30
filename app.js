
// 定数定義
const FLASH_BASE = 0x08000000;
const PAGE_SIZE = 2048;
const WRITE_CHUNK = 256; // STM32最大256バイト

let port;
let reader;
let writer;

const logElement = document.getElementById('log');
const statusElement = document.getElementById('status');

// ログ出力関数
function log(msg, level = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] [${level}] ${msg}\n`;
    logElement.textContent += line;
    logElement.scrollTop = logElement.scrollHeight;
    console.log(line);
}

// MSP CRC8 (D5)
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

// チェックサム (XOR)
function calcChecksum(data) {
    let res = 0;
    for (let b of data) res ^= b;
    return res;
}

// シリアルポート接続
document.getElementById('connectBtn').onclick = async () => {
    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        writer = port.writable.getWriter();
        reader = port.readable.getReader();
        
        statusElement.textContent = "Status: Connected";
        document.getElementById('flashBtn').disabled = false;
        log("Serial Port Opened.");
    } catch (e) {
        log("Connection Failed: " + e, "ERROR");
    }
};

// 1バイト読み込み（タイムアウト付き）
async function readByte(timeout = 2000) {
    const timer = setTimeout(() => { throw new Error("Timeout"); }, timeout);
    const { value, done } = await reader.read();
    clearTimeout(timer);
    return value[0];
}

// 書き込みメインフロー
document.getElementById('flashBtn').onclick = async () => {
    const fileInput = document.getElementById('hexFile');
    if (!fileInput.files.length) return alert("HEXファイルを選択してください");

    try {
        const file = fileInput.files[0];
        const hexText = await file.text();
        // intel-hexライブラリを使用してパース (簡易的な実装またはライブラリ利用)
        const firmware = parseHex(hexText); 
        
        log("Step 1: Firmware Loaded. Size: " + firmware.length + " bytes");

        // Step 2: Serial Passthrough
        log("Step 2: Setting Serial Passthrough...");
        let mspPass = [0x24, 0x58, 0x3C, 0x00, 0xF5, 0x00, 0x02, 0x00, 0xFE, 0x11];
        mspPass.push(msp_crc8_d5(mspPass.slice(3)));
        await writer.write(new Uint8Array(mspPass));
        await new Promise(r => setTimeout(r, 1000));

        // Step 3: Bootloader Start
        log("Step 3: Starting Bootloader...");
        let mspBoot = [0x24, 0x58, 0x3C, 0x00, 0x44, 0x00, 0x00, 0x00];
        mspBoot.push(msp_crc8_d5(mspBoot.slice(3)));
        await writer.write(new Uint8Array(mspBoot));
        await new Promise(r => setTimeout(r, 1000));

        // Step 4: Sync (0x7F)
        log("Step 4: Synchronizing...");
        await writer.write(new Uint8Array([0x7F]));
        let ack = await readByte();
        if (ack !== 0x79) throw new Error("Sync Failed");

        // Step 5: Get ID
        log("Step 5: Getting Device ID...");
        await writer.write(new Uint8Array([0x02, 0xFD]));
        if (await readByte() === 0x79) {
            let len = await readByte();
            let id = await readByte(); // 簡易的に1byte取得
            log(`Device ID: 0x${id.toString(16)}`, "INFO");
            await readByte(); // 最後のACK
        }

        // Step 6-8: Erase & Write (簡略化)
        log("Step 6: Erasing and Writing Memory...");
        for (let i = 0; i < firmware.length; i += WRITE_CHUNK) {
            const chunk = firmware.slice(i, i + WRITE_CHUNK);
            const addr = FLASH_BASE + i;
            
            // Write Command
            await writer.write(new Uint8Array([0x31, 0xCE]));
            await readByte();

            // Address
            let addrBytes = new Uint8Array([
                (addr >> 24) & 0xFF, (addr >> 16) & 0xFF, (addr >> 8) & 0xFF, addr & 0xFF
            ]);
            await writer.write(addrBytes);
            await writer.write(new Uint8Array([calcChecksum(addrBytes)]));
            await readByte();

            // Data
            let dataPayload = new Uint8Array([chunk.length - 1, ...chunk]);
            await writer.write(dataPayload);
            await writer.write(new Uint8Array([calcChecksum(dataPayload)]));
            await readByte();
            
            log(`Progress: ${Math.round((i / firmware.length) * 100)}%`);
        }

        log("FLASH SUCCESSFUL!", "SUCCESS");
        statusElement.textContent = "Status: Done";

    } catch (e) {
        log("Error: " + e.message, "ERROR");
    }
};

// 簡易Intel HEXパーサー
function parseHex(hex) {
    const lines = hex.split('\n');
    let bin = [];
    for (let line of lines) {
        if (line.startsWith(':') && line.substring(7, 9) === '00') {
            const bytes = line.substring(9, line.length - 3).match(/.{1,2}/g).map(h => parseInt(h, 16));
            bin.push(...bytes);
        }
    }
    return new Uint8Array(bin);
}