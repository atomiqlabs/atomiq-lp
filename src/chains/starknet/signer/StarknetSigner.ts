import * as mStarknet from '@scure/starknet';
import * as bip32 from "@scure/bip32";
import * as bip39 from '@scure/bip39';
import * as fs from "fs";
import {StarknetKeypairWallet} from "@atomiqlabs/chain-starknet";
import {Account, Provider} from "starknet";

export function getStarknetSigner(configuration: {MNEMONIC_FILE?: string, PRIVKEY?: string}, provider: Provider): Account {
    const mnemonicFile = configuration.MNEMONIC_FILE;
    let privKey = configuration.PRIVKEY;

    if(privKey==null && mnemonicFile==null) {
        throw new Error("Private key or mnemonic phrase file needs to be set!");
    }

    if(mnemonicFile!=null) {
        const mnemonic: string = fs.readFileSync(mnemonicFile).toString();
        let seed: Uint8Array;
        try {
            seed = bip39.mnemonicToSeedSync(mnemonic);
        } catch (e) {
            throw new Error("Error parsing mnemonic phrase!");
        }
        const hdKeyRoot = bip32.HDKey.fromMasterSeed(seed);
        const path44Acc0 = "m/44'/9004'/0'/0/0";
        const hdKey0 = hdKeyRoot.derive(path44Acc0);
        privKey = "0x" + mStarknet.grindKey(hdKey0.privateKey);
    }

    return new StarknetKeypairWallet(provider, privKey);
}
