import {AnchorProvider, Wallet} from "@coral-xyz/anchor";
import {Connection, Keypair} from "@solana/web3.js";
import {mnemonicToSeedSync} from "@scure/bip39";
import { derivePath } from 'ed25519-hd-key';
import * as fs from "fs";

export function getSolanaSigner(configuration: {RPC_URL: string, MNEMONIC_FILE?: string, PRIVKEY?: string}): (AnchorProvider & {signer: Keypair}) {
    const mnemonicFile = configuration.MNEMONIC_FILE;
    const privKey = configuration.PRIVKEY;

    if(privKey==null && mnemonicFile==null) {
        throw new Error("Private key or mnemonic phrase file needs to be set!");
    }

    let _signer: Keypair;

    if(privKey!=null) {
        _signer = Keypair.fromSecretKey(Buffer.from(privKey, "hex"));
    }

    let seed: Buffer;
    if(mnemonicFile!=null) {
        const mnemonic: string = fs.readFileSync(mnemonicFile).toString();
        try {
            seed = Buffer.from(mnemonicToSeedSync(mnemonic));
        } catch (e) {
            throw new Error("Error parsing mnemonic phrase!");
        }
        const path44Acc1 = "m/44'/501'/0'/0'";
        const derivedPath = derivePath(path44Acc1, seed.toString("hex"));
        _signer = Keypair.fromSeed(derivedPath.key);
    }

    const connection = new Connection(configuration.RPC_URL, "processed");
    const AnchorSigner: (AnchorProvider & {signer: Keypair}) = new AnchorProvider(connection, new Wallet(_signer), {
        preflightCommitment: "processed"
    }) as any;

    AnchorSigner.signer = _signer;
    return AnchorSigner;
}
