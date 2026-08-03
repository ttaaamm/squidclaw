import { backupCli } from "./backup.js";
console.log(await backupCli(process.argv.slice(2)));
