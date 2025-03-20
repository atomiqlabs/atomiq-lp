import {ISpvVaultSigner} from "@atomiqlabs/lp-lib";
import { Transaction } from "@scure/btc-signer";
import * as fs from "fs";
import {mnemonicToSeedSync} from "@scure/bip39";
import {HDKey} from "@scure/bip32";
import {p2tr} from "@scure/btc-signer";
import {BTC_NETWORK} from "@scure/btc-signer/utils";
import {pubSchnorr} from "@scure/btc-signer/utils";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function fromBase26(val: string): bigint {
    let result = 0n;
    for(let i=0;i<val.length;i++) {
        result *= 26n;
        const word = ALPHABET.indexOf(val.charAt(i));
        if(word===-1) throw new Error("Invalid character: "+val.charAt(i));
        result += BigInt(word);
    }
    return result;
}

const BIP32_PURPOSE = fromBase26("ATOMIQ");

export class BitcoinSpvVaultSigner implements ISpvVaultSigner {

    private readonly root: HDKey;
    private readonly network: BTC_NETWORK;

    constructor(mnemonicFile: string, network: BTC_NETWORK) {
        let seed: Uint8Array;
        const mnemonic: string = fs.readFileSync(mnemonicFile).toString();
        try {
            seed = mnemonicToSeedSync(mnemonic);
        } catch (e) {
            throw new Error("Error parsing mnemonic phrase!");
        }
        this.root = HDKey.fromMasterSeed(seed);
        this.network = network;
    }

    getKey(chainId: string, vaultId: bigint): HDKey {
        if(vaultId >= 0x80000000) throw new Error("Vault ID too high, maximum: 0x80000000");
        const chainIdAccount = fromBase26(chainId.substring(0, 6))
        const derivationPath = "m/"+BIP32_PURPOSE.toString(10)+"'/0'/"+chainIdAccount.toString(10)+"'/0/"+vaultId.toString(10);
        return this.root.derive(derivationPath);
    }

    getAddress(chainId: string, vaultId: bigint): Promise<string> {
        const key = this.getKey(chainId, vaultId);
        const data = p2tr(pubSchnorr(key.privateKey), null, this.network);
        return Promise.resolve(data.address);
    }

    getAddressType(): "p2tr" {
        return "p2tr";
    }

    init(): Promise<void> {
        return Promise.resolve();
    }

    signPsbt(chainId: string, vaultId: bigint, psbt: Transaction, inputs: number[]): Promise<Transaction> {
        const key = this.getKey(chainId, vaultId);
        inputs.forEach(vin => {
            psbt.signIdx(key, vin, [0x01]);
        });
        psbt.finalize();
        return Promise.resolve(psbt);
    }

}
