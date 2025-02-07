import * as dotenv from "dotenv";
dotenv.config();

import {Keypair} from "@solana/web3.js";
import * as fs from "fs";
import {parse, stringify} from "yaml";

const keypair = Keypair.generate();

const address = keypair.publicKey.toBase58();

const result = parse(fs.readFileSync(process.env.CONFIG_FILE).toString());
result.SOLANA.PRIVKEY = Buffer.from(keypair.secretKey).toString("hex");
result.SOLANA.ADDRESS = address;
fs.writeFileSync(process.env.CONFIG_FILE, stringify(result));

console.log("Generated address: "+address);
