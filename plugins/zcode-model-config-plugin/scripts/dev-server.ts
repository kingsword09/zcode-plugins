import { startUiServer, closeUiServer } from "../src/ui/server.ts";

const handle = await startUiServer({
  projectRoot: process.argv[2] ?? process.cwd(),
  openBrowser: false,
});
console.log(`PORT=${handle.port}`);
console.log(`TOKEN=${handle.token}`);

// Keep alive until stdin closes or 10 minutes pass.
process.stdin.resume();
setTimeout(() => {
  void closeUiServer().then(() => process.exit(0));
}, 10 * 60 * 1000).unref();
