// Prints each LiteSVM step so a native crash shows which call caused it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Clock, LiteSVM } from "litesvm";
import { Keypair } from "@solana/web3.js";
import * as sdk from "../../dist/index.js";

const SO = fileURLToPath(new URL("../../../../target/deploy/solml_escrow.so", import.meta.url));
const step = (s) => console.log(`probe: ${s}`);
step("new LiteSVM");
const svm = new LiteSVM();
step("airdrop");
const kp = Keypair.generate();
svm.airdrop(kp.publicKey, 1_000_000_000n);
step("addProgramFromFile");
svm.addProgramFromFile(sdk.PROGRAM_ID, SO);
step("minimumBalanceForRentExemption");
svm.minimumBalanceForRentExemption(BigInt(readFileSync(SO).length));
step("getClock");
const c = svm.getClock();
step("setClock");
svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, 1_800_000_000n));
step("getAccount");
svm.getAccount(kp.publicKey);
step("done");
