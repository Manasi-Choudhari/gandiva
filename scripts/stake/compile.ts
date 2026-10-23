// Builds contracts/SellerStakeV2.sol with Foundry and writes contracts/SellerStakeV2.json (ABI + bytecode), which the server uses.
// SellerStake.json (V1) is frozen as deployed; it is only needed to withdraw the V1 bonds. CI fails if this file goes stale.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const name = "SellerStakeV2";
execFileSync("forge", ["build"], { stdio: "inherit" });
const out = JSON.parse(readFileSync(`foundry/out/${name}.sol/${name}.json`, "utf8"));
const compiler = out.metadata.compiler.version;
writeFileSync(`contracts/${name}.json`, JSON.stringify({ compiler, abi: out.abi, bytecode: out.bytecode.object }, null, 2) + "\n");
console.log(`compiled with solc ${compiler}: ${(out.bytecode.object.length - 2) / 2} bytes`);
