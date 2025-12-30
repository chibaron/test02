let port;
let reader;
let writer;

const terminal = document.getElementById("terminal");
const input = document.getElementById("input");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");

function log(text) {
  terminal.textContent += text;
  terminal.scrollTop = terminal.scrollHeight;
}

connectBtn.onclick = async () => {
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    writer = port.writable.getWriter();
    reader = port.readable.getReader();

    log("=== Connected ===\n");

    input.disabled = false;
    disconnectBtn.disabled = false;
    connectBtn.disabled = true;

    readLoop();
  } catch (e) {
    log(`Error: ${e}\n`);
  }
};

disconnectBtn.onclick = async () => {
  try {
    reader.cancel();
    reader.releaseLock();
    writer.releaseLock();
    await port.close();
  } catch {}

  input.disabled = true;
  disconnectBtn.disabled = true;
  connectBtn.disabled = false;
  log("\n=== Disconnected ===\n");
};

async function readLoop() {
  while (true) {
    try {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        log(new TextDecoder().decode(value));
      }
    } catch (e) {
      break;
    }
  }
}

input.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    const text = input.value + "\n";
    input.value = "";
    await writer.write(new TextEncoder().encode(text));
  }
});
