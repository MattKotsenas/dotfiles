import { connect } from "node:net";
import { text } from "node:stream/consumers";

const [port, nonce] = process.argv.slice(2);
const watchdog = setTimeout(() => process.exit(98), 30000);
const stdin = await text(process.stdin);
const socket = connect({ host: "127.0.0.1", port: Number(port) });
let buffered = "";
socket.on("connect", () => {
  socket.write(
    JSON.stringify({
      event: "ready",
      nonce,
      pid: process.pid,
      cwd: process.cwd(),
      prefix: process.env.PI_BG_TEST,
      stdin,
    }) + "\n",
  );
  process.stdout.write(`READY ${nonce}\n`);
});
socket.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
    const { op, exitCode = 7 } = JSON.parse(buffered.slice(0, at));
    buffered = buffered.slice(at + 1);
    if (op === "ping") socket.write(JSON.stringify({ event: "pong", nonce }) + "\n");
    if (op === "finish") {
      clearTimeout(watchdog);
      process.stdout.write("DONE ü 雪\n", () => {
        process.stderr.write("STDERR LINE\n", () => socket.end(() => process.exit(exitCode)));
      });
    }
  }
});
socket.on("error", (error) => {
  process.stderr.write(`Fixture socket error: ${error.message}\n`);
  process.exit(97);
});
