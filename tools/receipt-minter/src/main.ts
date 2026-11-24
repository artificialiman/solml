#!/usr/bin/env node
/**
 * receipt-minter — issues SolML receipts as soulbound Bubblegum V2 cNFTs.
 *
 *   setup  --rpc <das-rpc> --keypair <file> [--depth 14 --buffer 64 --canopy 8]
 *          Creates the receipts collection (MPL-Core, BubblegumV2 + PermanentFreezeDelegate plugins)
 *          and a V2 merkle tree. Prints both addresses.
 *   files  <contract.solml> [--sss f]... --ir-uri <uri> --out <dir> [--closed-sig <signature> --rpc <rpc>]
 *          Writes one metadata JSON per recipient (bound phase, or closed phase from the close tx).
 *          Upload the folder to permanent storage; its base URI is --metadata-base below.
 *   mint   <contract.solml> [--sss f]... --rpc <das-rpc> --keypair <file> --tree <addr> --collection <addr>
 *          --metadata-base <uri>
 *          Mints one receipt per recipient and makes each non-transferable.
 *   close  <contract.solml> [--sss f]... --rpc <das-rpc> --keypair <file> --collection <addr>
 *          --metadata-base <uri> --asset <id>...
 *          Points each receipt at its closed-phase metadata.
 *
 * Metadata files are not uploaded by this tool. Receipts require a DAS-capable RPC.
 */
import "@solml/sdk/dist/quiet.js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@solml/compiler";
import type { CompileOutput } from "@solml/compiler";
import {
  buildReceiptMetadata,
  decodeEscrowClosed,
  findEvent,
  receiptName,
  receiptRecipients,
  RECEIPT_SYMBOL,
} from "@solml/sdk";
import type { EscrowClosedEvent, ReceiptRecipient } from "@solml/sdk";
import {
  createTreeV2,
  getAssetWithProof,
  mintV2,
  mplBubblegum,
  parseLeafFromMintV2Transaction,
  setNonTransferableV2,
  updateMetadataV2,
} from "@metaplex-foundation/mpl-bubblegum";
import { createCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { createSignerFromKeypair, generateSigner, keypairIdentity, publicKey } from "@metaplex-foundation/umi";
import type { Umi } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { dasApi } from "@metaplex-foundation/digital-asset-standard-api";
import type { DasApiInterface } from "@metaplex-foundation/digital-asset-standard-api";
import { Connection } from "@solana/web3.js";

type Flags = Map<string, string[]>;

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags.set(a.slice(2), [...(flags.get(a.slice(2)) ?? []), argv[++i] ?? ""]);
    else pos.push(a);
  }
  return { pos, flags };
}

const one = (f: Flags, k: string): string => {
  const v = f.get(k)?.at(-1);
  if (!v) throw new Error(`--${k} is required`);
  return v;
};

function contract(pos: string[], f: Flags): CompileOutput {
  const file = pos[0];
  if (!file) throw new Error("contract file is required");
  return compile({
    contract: { file, text: readFileSync(file, "utf8") },
    sheets: (f.get("sss") ?? []).map((s) => ({ file: s, text: readFileSync(s, "utf8") })),
  });
}

type DasUmi = Umi & { rpc: DasApiInterface };

function umiFor(f: Flags): DasUmi {
  const umi = createUmi(one(f, "rpc")).use(mplBubblegum()).use(mplCore()).use(dasApi());
  const secret = Uint8Array.from(JSON.parse(readFileSync(one(f, "keypair"), "utf8")) as number[]);
  const kp = umi.eddsa.createKeypairFromSecretKey(secret);
  umi.use(keypairIdentity(createSignerFromKeypair(umi, kp)));
  return umi as DasUmi;
}

const fileName = (out: CompileOutput, r: ReceiptRecipient) => `${out.ir.id}.${r.role}${r.seat ?? ""}.json`;

async function closedEvent(rpc: string, sig: string): Promise<EscrowClosedEvent> {
  const tx = await new Connection(rpc, "confirmed").getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const ev = findEvent(tx?.meta?.logMessages ?? [], "EscrowClosed", decodeEscrowClosed);
  if (!ev) throw new Error("no EscrowClosed event in that transaction");
  return ev;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parse(rest);

  if (cmd === "setup") {
    const umi = umiFor(flags);
    const collection = generateSigner(umi);
    await createCollection(umi, {
      collection,
      name: "SolML Escrow Receipts",
      uri: flags.get("collection-uri")?.at(-1) ?? "",
      plugins: [
        { type: "BubblegumV2" },
        { type: "PermanentFreezeDelegate", frozen: false, authority: { type: "Address", address: umi.identity.publicKey } },
      ],
    }).sendAndConfirm(umi);
    const merkleTree = generateSigner(umi);
    const builder = await createTreeV2(umi, {
      merkleTree,
      maxDepth: Number(flags.get("depth")?.at(-1) ?? 14),
      maxBufferSize: Number(flags.get("buffer")?.at(-1) ?? 64),
      canopyDepth: Number(flags.get("canopy")?.at(-1) ?? 8),
    });
    await builder.sendAndConfirm(umi);
    console.log(`collection ${collection.publicKey}\ntree       ${merkleTree.publicKey}`);
    return;
  }

  if (cmd === "files") {
    const out = contract(pos, flags);
    const closed = flags.has("closed-sig") ? await closedEvent(one(flags, "rpc"), one(flags, "closed-sig")) : undefined;
    const dir = one(flags, "out");
    mkdirSync(dir, { recursive: true });
    for (const r of receiptRecipients(out.ir)) {
      const meta = buildReceiptMetadata({ ir: out.ir, recipient: r, irUri: one(flags, "ir-uri"), closed });
      writeFileSync(join(dir, fileName(out, r)), JSON.stringify(meta, null, 2) + "\n");
    }
    console.log(`wrote ${receiptRecipients(out.ir).length} metadata files to ${dir}`);
    return;
  }

  if (cmd === "mint") {
    const out = contract(pos, flags);
    const umi = umiFor(flags);
    const merkleTree = publicKey(one(flags, "tree"));
    const coreCollection = publicKey(one(flags, "collection"));
    const base = one(flags, "metadata-base").replace(/\/$/, "");
    for (const r of receiptRecipients(out.ir)) {
      const leafOwner = publicKey(r.owner);
      const { signature } = await mintV2(umi, {
        leafOwner,
        merkleTree,
        coreCollection,
        metadata: {
          name: receiptName(out.ir, r),
          symbol: RECEIPT_SYMBOL,
          uri: `${base}/${fileName(out, r)}`,
          sellerFeeBasisPoints: 0,
          collection: coreCollection,
          creators: [],
        },
      }).sendAndConfirm(umi);
      const leaf = await parseLeafFromMintV2Transaction(umi, signature);
      const asset = await getAssetWithProof(umi, leaf.id, { truncateCanopy: true });
      await setNonTransferableV2(umi, { ...asset, coreCollection }).sendAndConfirm(umi);
      console.log(`${r.role}${r.seat ?? ""}  ${r.owner}  asset ${leaf.id}`);
    }
    return;
  }

  if (cmd === "close") {
    const out = contract(pos, flags);
    const umi = umiFor(flags);
    const coreCollection = publicKey(one(flags, "collection"));
    const base = one(flags, "metadata-base").replace(/\/$/, "");
    const recips = receiptRecipients(out.ir);
    for (const id of flags.get("asset") ?? []) {
      const asset = await getAssetWithProof(umi, publicKey(id), { truncateCanopy: true });
      const r = recips.find((x) => x.owner === asset.leafOwner.toString());
      if (!r) throw new Error(`asset ${id} is not owned by a party of this contract`);
      if (!asset.currentMetadata) throw new Error(`asset ${id} is not a Bubblegum V2 asset`);
      await updateMetadataV2(umi, {
        ...asset,
        coreCollection,
        currentMetadata: asset.currentMetadata,
        updateArgs: { uri: `${base}/${fileName(out, r)}` },
      }).sendAndConfirm(umi);
      console.log(`updated ${id} (${r.role}${r.seat ?? ""})`);
    }
    return;
  }

  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 21).join("\n"));
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
