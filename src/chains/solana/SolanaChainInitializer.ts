import {ChainInitializer} from "../ChainInitializer";
import {SolanaBtcRelay, SolanaFees, SolanaSwapData, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import {
    bnParser,
    createCommand,
    numberParser,
    objectParser,
    percentageToPpmParser,
    stringParser,
    ConfigParser
} from "crosslightning-server-base";
import * as BN from "bn.js";
import {StorageManager} from "crosslightning-intermediary";
import {getSolanaSigner} from "./signer/AnchorSigner";
import {SolanaChainEvents} from "crosslightning-solana/dist/solana/events/SolanaChainEvents";
import {PublicKey} from "@solana/web3.js";

export const publicKeyParser: (optional?: boolean) => ConfigParser<PublicKey> = (optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="string") throw new Error("Invalid data, must be string");
    return new PublicKey(data);
};

const template = {
    RPC_URL: stringParser(),
    MAX_FEE_MICRO_LAMPORTS: numberParser(false, 1000),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(128, 128, true),
    ADDRESS: publicKeyParser(true),
    SECURITY_DEPOSIT_APY: percentageToPpmParser(0),

    JITO: objectParser({
        PUBKEY: publicKeyParser(),
        ENDPOINT: stringParser(),
    }, null, true),

    STATIC_TIP: bnParser(new BN(0), null, true)
};

export const SolanaChainInitializer: ChainInitializer<SolanaSwapData, any, typeof template> = {
    loadChain: (configuration, bitcoinRpc, allowedTokens) => {
        const directory = process.env.STORAGE_DIR;

        const AnchorSigner = getSolanaSigner(configuration);
        const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc, process.env.BTC_RELAY_CONTRACT_ADDRESS);
        const swapContract = new SolanaSwapProgram(
            AnchorSigner,
            btcRelay,
            new StorageManager<StoredDataAccount>(directory+"/solaccounts"),
            process.env.SWAP_CONTRACT_ADDRESS,
            null,
            new SolanaFees(
                AnchorSigner.connection,
                configuration.MAX_FEE_MICRO_LAMPORTS,
                8,
                100,
                "auto",
                configuration.STATIC_TIP!=null ? () => configuration.STATIC_TIP : null,
                configuration.JITO!=null ? {
                    address: configuration.JITO.PUBKEY.toString(),
                    endpoint: configuration.JITO.ENDPOINT
                } : null
            )
        );
        const chainEvents = new SolanaChainEvents(directory, AnchorSigner, swapContract);

        return {
            swapContract,
            chainEvents,
            btcRelay,
            allowedTokens,
            commands: [
                createCommand(
                    "airdrop",
                    "Requests an airdrop of SOL tokens (only works on devnet!)",
                    {
                        args: {},
                        parser: async (args, sendLine) => {
                            let signature = await AnchorSigner.connection.requestAirdrop(AnchorSigner.publicKey, 1500000000);
                            sendLine("Transaction sent, signature: "+signature+" waiting for confirmation...");
                            const latestBlockhash = await AnchorSigner.connection.getLatestBlockhash();
                            await AnchorSigner.connection.confirmTransaction(
                                {
                                    signature,
                                    ...latestBlockhash,
                                },
                                "confirmed"
                            );
                            return "Airdrop transaction confirmed!";
                        }
                    }
                )
            ]
        };
    },
    configuration: objectParser(template, (data) => {
        if(data.MNEMONIC_FILE==null && data.PRIVKEY==null) throw new Error("Mnemonic file or explicit private key must be specified!");
    })
};