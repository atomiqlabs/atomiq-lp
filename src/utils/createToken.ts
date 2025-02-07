import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

import {createMint} from "@solana/spl-token";
import {getSolanaSigner} from "../chains/solana/signer/AnchorSigner";
import {parse, stringify} from "yaml";
import {IntermediaryConfig} from "../IntermediaryConfig";

const AnchorSigner = getSolanaSigner(IntermediaryConfig.SOLANA);

async function main() {
    const result = parse(fs.readFileSync(process.env.CONFIG_FILE).toString());

    const mintWBTC = await createMint(AnchorSigner.connection, AnchorSigner.signer, AnchorSigner.publicKey, null, 8);
    const mintUSDC = await createMint(AnchorSigner.connection, AnchorSigner.signer, AnchorSigner.publicKey, null, 6);
    const mintUSDT = await createMint(AnchorSigner.connection, AnchorSigner.signer, AnchorSigner.publicKey, null, 6);

    if(result.ASSETS==null) result.ASSETS = {};
    result.ASSETS["WBTC"] = {
        address: mintWBTC.toBase58(),
        decimals: 8,
        pricing: "WBTCBTC"
    };
    result.ASSETS["USDC"] = {
        address: mintUSDC.toBase58(),
        decimals: 6,
        pricing: "!BTCUSDC"
    };
    result.ASSETS["USDT"] = {
        address: mintUSDT.toBase58(),
        decimals: 6,
        pricing: "!BTCUSDT"
    };

    fs.writeFileSync(process.env.CONFIG_FILE, stringify(result));

    console.log("Token ID WBTC: ", mintWBTC.toBase58());
    console.log("Token ID USDC: ", mintUSDC.toBase58());
    console.log("Token ID USDT: ", mintUSDT.toBase58());
}

main();