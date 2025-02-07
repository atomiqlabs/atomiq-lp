import * as dotenv from "dotenv";
dotenv.config();

import {getOrCreateAssociatedTokenAccount, mintTo} from "@solana/spl-token";
import {getSolanaSigner} from "../chains/solana/signer/AnchorSigner";
import {PublicKey} from "@solana/web3.js";
import {IntermediaryConfig} from "../IntermediaryConfig";

const AnchorSigner = getSolanaSigner(IntermediaryConfig.SOLANA);

async function mint(amount: number, acc: PublicKey, token: string): Promise<boolean> {
    let useToken = IntermediaryConfig.ASSETS[token];
    if(useToken==null) return false;

    const address = new PublicKey(useToken.chains["SOLANA"].address);

    const ata = await getOrCreateAssociatedTokenAccount(AnchorSigner.connection, AnchorSigner.signer, address, acc);

    const signature = await mintTo(AnchorSigner.connection, AnchorSigner.signer, address, ata.address, AnchorSigner.signer, amount);

    console.log("Mint signature: ", signature);

    return true;
}

async function main() {
    if(process.argv.length<4) {
        console.error("Needs at least 2 arguments");
        console.error("Usage: node mint.js <token:WBTC,USDC,USDT> <amount> [address (optional)]");
        return;
    }

    const token = process.argv[2];
    const amount = parseInt(process.argv[3]);

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    let pubKey = AnchorSigner.publicKey;
    if(process.argv.length>4) {
        pubKey = new PublicKey(process.argv[4]);
        if(pubKey==null) {
            console.error("Invalid address argument (not a valid solana address)");
            return;
        }
    }

    if(!(await mint(amount, pubKey, token))) {
        console.error("Invalid token argument (must be one of WBTC, USDC, USDT)");
        return;
    }
}

main();
