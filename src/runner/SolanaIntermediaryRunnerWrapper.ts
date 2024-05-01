import {BitcoinRpc, BtcRelay, ChainEvents, ChainSwapType, SwapContract, SwapData} from "crosslightning-base";
import {ISwapPrice} from "crosslightning-intermediary";
import {SolanaIntermediaryRunner} from "./SolanaIntermediaryRunner";
import * as BN from "bn.js";
import {
    cmdEnumParser,
    cmdNumberParser,
    cmdStringParser,
    CommandHandler,
    createCommand
} from "../commands/CommandHandler";
import {AnchorProvider} from "@coral-xyz/anchor";
import {Keypair, PublicKey} from "@solana/web3.js";
import {getUnauthenticatedLndGrpc} from "../btc/LND";
import * as lncli from "ln-service";
import {fromDecimal, toDecimal} from "../Utils";

export class SolanaIntermediaryRunnerWrapper<T extends SwapData> extends SolanaIntermediaryRunner<T> {

    cmdHandler: CommandHandler;

    constructor(
        directory: string,
        signer: (AnchorProvider & {signer: Keypair}),
        tokens: {
            [ticker: string]: {
                address: PublicKey,
                decimals: number
            }
        },
        prices: ISwapPrice,
        bitcoinRpc: BitcoinRpc<any>,
        btcRelay: BtcRelay<any, any, any>,
        swapContract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>
    ) {
        super(directory, signer, tokens, prices, bitcoinRpc, btcRelay, swapContract, chainEvents);
        this.cmdHandler = new CommandHandler([
            createCommand(
                "status",
                "Fetches the current status of the bitcoin RPC, LND gRPC & intermediary application",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];

                        let solRpcOK = true;
                        try {
                            await this.signer.connection.getLatestBlockhash();
                        } catch (e) {
                            solRpcOK = false;
                        }
                        reply.push("Solana RPC status:");
                        reply.push("    Status: "+(solRpcOK ? "ready" : "offline!"));

                        const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);
                        reply.push("Bitcoin RPC status:");
                        reply.push("    Status: "+(btcRpcStatus==null ? "offline" : btcRpcStatus.ibd ? "verifying blockchain" : "ready"));
                        if(btcRpcStatus!=null) {
                            reply.push("    Verification progress: "+(btcRpcStatus.verificationProgress*100).toFixed(4)+"%");
                            reply.push("    Synced headers: "+btcRpcStatus.headers);
                            reply.push("    Synced blocks: "+btcRpcStatus.blocks);
                        }

                        const lndRpcStatus = await this.getLNDWalletStatus(getUnauthenticatedLndGrpc());
                        reply.push("LND gRPC status:");
                        reply.push("    Wallet status: "+lndRpcStatus);
                        if(btcRpcStatus!="offline") {
                            const resp = await lncli.getWalletInfo({
                                lnd: this.LND
                            });
                            reply.push("    Synced to chain: "+resp.is_synced_to_chain);
                            reply.push("    Blockheight: "+resp.current_block_height);
                            reply.push("    Connected peers: "+resp.peers_count);
                            reply.push("    Channels active: "+resp.active_channels_count);
                            reply.push("    Channels pending: "+resp.pending_channels_count);
                            reply.push("    Node pubkey: "+resp.public_key);
                        }

                        const balance = await this.swapContract.getBalance(this.swapContract.getNativeCurrencyAddress(), false);
                        reply.push("Intermediary status:");
                        reply.push("    Funds: " + (balance.toNumber()/Math.pow(10, 9)).toFixed(9));
                        reply.push("    Has enough funds (>0.1 SOL): " + (balance.gt(new BN(100000000)) ? "yes" : "no"));

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the Solana & Bitcoin address of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        reply.push("Solana address: "+this.swapContract.getAddress());
                        const resp = await lncli.createChainAddress({
                            lnd: this.LND,
                            format: "p2wpkh"
                        }).catch(e => console.error(e));
                        if(resp==null) {
                            reply.push("Bitcoin address: unknown (LND node unresponsive - not initialized?)");
                        } else {
                            reply.push("Bitcoin address: "+resp.address);
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the balances of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        reply.push("Solana wallet balances (non-trading):");
                        for(let token in this.tokens) {
                            const tokenData = this.tokens[token];
                            reply.push("   "+token+": "+toDecimal(await this.swapContract.getBalance(tokenData.address, false), tokenData.decimals));
                        }
                        reply.push("LP Vault balances (trading):");
                        for(let token in this.tokens) {
                            const tokenData = this.tokens[token];
                            reply.push("   "+token+": "+toDecimal(await this.swapContract.getBalance(tokenData.address, true) || new BN(0), tokenData.decimals));
                        }

                        reply.push("Bitcoin balances (trading):");
                        const {utxos} = await lncli.getUtxos({lnd: this.LND, min_confirmations: 0});
                        let unconfirmed = new BN(0);
                        let confirmed = new BN(0);
                        utxos.forEach(utxo => {
                            if(utxo.confirmation_count===0) {
                                unconfirmed = unconfirmed.add(new BN(utxo.tokens));
                            } else {
                                confirmed = confirmed.add(new BN(utxo.tokens));
                            }
                        });
                        reply.push("   BTC: "+toDecimal(confirmed, 8)+" (+"+toDecimal(unconfirmed, 8)+")");
                        const channelBalance = await lncli.getChannelBalance({lnd: this.LND});
                        reply.push("   BTC-LN: "+toDecimal(new BN(channelBalance.channel_balance), 8)+" (+"+toDecimal(new BN(channelBalance.pending_balance), 8)+")");

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "connectlightning",
                "Connect to a lightning node peer",
                {
                    args: {
                        node: {
                            base: true,
                            description: "Remote node identification as <pubkey>@<ip address>",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Data cannot be null");
                                const arr = data.split("@");
                                if(arr.length!==2) throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                                return {
                                    pubkey: arr[0],
                                    address: arr[1]
                                };
                            }
                        }
                    },
                    parser: async (args, sendLine) => {
                        sendLine("Connecting to remote peer...");
                        await lncli.addPeer({
                            lnd: this.LND,
                            public_key: args.node.pubkey,
                            socket: args.node.address
                        });
                        return "Connection to the lightning peer established! Public key: "+args.node.pubkey;
                    }
                }
            ),
            createCommand(
                "openchannel",
                "Opens up a lightning network payment channel",
                {
                    args: {
                        amount: {
                            base: true,
                            description: "Amount of BTC to use inside a lightning",
                            parser: cmdNumberParser(true, 0)
                        },
                        node: {
                            base: true,
                            description: "Remote node identification as <pubkey>@<ip address>",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Data cannot be null");
                                const arr = data.split("@");
                                if(arr.length!==2) throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                                return {
                                    pubkey: arr[0],
                                    address: arr[1]
                                };
                            }
                        }
                    },
                    parser: async (args, sendLine) => {
                        const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                        if(amtBN==null) throw new Error("Amount cannot be parsed");
                        const resp = await lncli.openChannel({
                            lnd: this.LND,
                            local_tokens: amtBN.toNumber(),
                            min_confirmations: 0,
                            partner_public_key: args.node.pubkey,
                            partner_socket: args.node.address,
                            fee_rate: 1000,
                            base_fee_mtokens: "1000"
                        });
                        return "Lightning channel funded, wait for TX confirmations! txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "closechannel",
                "Attempts to cooperatively close a lightning network channel",
                {
                    args: {
                        channelId: {
                            base: true,
                            description: "Channel ID to close cooperatively",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        const resp = await lncli.closeChannel({
                            lnd: this.LND,
                            is_force_close: false,
                            id: args.channelId
                        });
                        return "Lightning channel closed, txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "forceclosechannel",
                "Force closes a lightning network channel",
                {
                    args: {
                        channelId: {
                            base: true,
                            description: "Channel ID to force close",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        const resp = await lncli.closeChannel({
                            lnd: this.LND,
                            is_force_close: true,
                            id: args.channelId
                        });
                        return "Lightning channel closed, txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "listchannels",
                "Lists existing lightning channels",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const {channels} = await lncli.getChannels({
                            lnd: this.LND
                        });
                        const reply: string[] = [];
                        reply.push("Opened channels:");
                        for(let channel of channels) {
                            reply.push(" - "+channel.id);
                            reply.push("    Peer: "+channel.partner_public_key);
                            reply.push("    State: "+(channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive"));
                            reply.push("    Balance: "+toDecimal(new BN(channel.local_balance), 8)+"/"+toDecimal(new BN(channel.capacity), 8)+" ("+(channel.local_balance/channel.capacity*100).toFixed(2)+"%)");
                            reply.push("    Unsettled balance: "+toDecimal(new BN(channel.unsettled_balance), 8));
                        }
                        const {pending_channels} = await lncli.getPendingChannels({
                            lnd: this.LND
                        });
                        if(pending_channels.length>0) {
                            reply.push("Pending channels:");
                            for(let channel of pending_channels) {
                                reply.push(" - "+channel.transaction_id+":"+channel.transaction_vout);
                                reply.push("    Peer: "+channel.partner_public_key);
                                reply.push("    State: "+(channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive"));
                                reply.push("    Balance: "+toDecimal(new BN(channel.local_balance), 8)+"/"+toDecimal(new BN(channel.capacity), 8)+" ("+(channel.local_balance/channel.capacity*100).toFixed(2)+"%)");
                                if(channel.is_opening) reply.push("    Funding txId: "+channel.transaction_id);
                                if(channel.is_closing) {
                                    reply.push("    Is timelocked: "+channel.is_timelocked);
                                    if(channel.is_timelocked) reply.push("    Blocks till claimable: "+channel.timelock_blocks);
                                    reply.push("    Close txId: "+channel.close_transaction_id);
                                }
                            }
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfer wallet balance to an external address",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: WSOL, USDC, USDT, WBTC, BTC",
                            parser: cmdEnumParser<"WSOL" | "USDC" | "USDT" | "WBTC" | "BTC">(["WSOL", "USDC", "USDT", "WBTC", "BTC"])
                        },
                        address: {
                            base: true,
                            description: "Destination address",
                            parser: cmdStringParser()
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(args.asset==="BTC") {
                            const amtBN = fromDecimal(args.amount.toFixed(8), 8);

                            const resp = await lncli.sendToChainAddress({
                                lnd: this.LND,
                                tokens: amtBN.toNumber(),
                                address: args.address,
                                utxo_confirmations: 0
                            });

                            return "Transaction sent, txId: "+resp.id;
                        }

                        const tokenData = this.tokens[args.asset];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await this.swapContract.txsTransfer(tokenData.address, amtBN, args.address);
                        await this.swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Transfer transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "transferlightning",
                "Transfer lightning wallet balance, pay lightning network invoice",
                {
                    args: {
                        invoice: {
                            base: true,
                            description: "Lightning network invoice to pay (must specify an amount!)",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        sendLine("Sending lightning tx, waiting for confirmation...");
                        const resp = await lncli.pay({
                            lnd: this.LND,
                            request: args.invoice
                        });
                        if(resp.is_confirmed) {
                            return "Lightning transaction confirmed! Preimage: "+resp.secret;
                        }
                        return "Lightning transaction is taking longer than expected, will be handled in the background!";
                    }
                }
            ),
            createCommand(
                "receivelightning",
                "Creates a lightning network invoice",
                {
                    args: {
                        amount: {
                            base: true,
                            description: "Amount of BTC to receive over lightning",
                            parser: cmdNumberParser(true, 0, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                        const resp = await lncli.createInvoice({
                            lnd: this.LND,
                            mtokens: amtBN==null ? undefined : amtBN.mul(new BN(1000)).toString(10)
                        });
                        return "Lightning network invoice: "+resp.request;
                    }
                }
            ),
            createCommand(
                "deposit",
                "Deposits Solana wallet balance to an LP Vault",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: WSOL, USDC, USDT, WBTC",
                            parser: cmdEnumParser<"WSOL" | "USDC" | "USDT" | "WBTC">(["WSOL", "USDC", "USDT", "WBTC"])
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const tokenData = this.tokens[args.asset];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await this.swapContract.txsDeposit(tokenData.address, amtBN);
                        await this.swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Deposit transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "withdraw",
                "Withdraw LP Vault balance to node's Solana wallet",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: WSOL, USDC, USDT, WBTC",
                            parser: cmdEnumParser<"WSOL" | "USDC" | "USDT" | "WBTC">(["WSOL", "USDC", "USDT", "WBTC"])
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const tokenData = this.tokens[args.asset];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await this.swapContract.txsWithdraw(tokenData.address, amtBN);
                        await this.swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Withdrawal transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "getreputation",
                "Checks the LP node's reputation stats",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reply: string[] = [];
                        reply.push("LP node's reputation:");
                        for(let token in this.tokens) {
                            const tokenData = this.tokens[token];
                            const reputation = await this.swapContract.getIntermediaryReputation(this.swapContract.getAddress(), tokenData.address);
                            if(reputation==null) {
                                reply.push(token+": No reputation");
                                continue;
                            }
                            reply.push(token+":");
                            const lnData = reputation[ChainSwapType.HTLC];
                            reply.push("   LN:");
                            reply.push("       successes: "+toDecimal(lnData.successVolume, tokenData.decimals)+" ("+lnData.successCount.toString(10)+" swaps)");
                            reply.push("       fails: "+toDecimal(lnData.failVolume, tokenData.decimals)+" ("+lnData.failCount.toString(10)+" swaps)");
                            reply.push("       coop closes: "+toDecimal(lnData.coopCloseVolume, tokenData.decimals)+" ("+lnData.coopCloseCount.toString(10)+" swaps)");

                            const onChainData = reputation[ChainSwapType.CHAIN];
                            reply.push("   On-chain:");
                            reply.push("       successes: "+toDecimal(onChainData.successVolume, tokenData.decimals)+" ("+onChainData.successCount.toString(10)+" swaps)");
                            reply.push("       fails: "+toDecimal(onChainData.failVolume, tokenData.decimals)+" ("+onChainData.failCount.toString(10)+" swaps)");
                            reply.push("       coop closes: "+toDecimal(onChainData.coopCloseVolume, tokenData.decimals)+" ("+onChainData.coopCloseCount.toString(10)+" swaps)");
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "airdrop",
                "Requests an airdrop of SOL tokens (only works on devnet!)",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        let signature = await this.signer.connection.requestAirdrop(this.signer.publicKey, 1500000000);
                        sendLine("Transaction sent, signature: "+signature+" waiting for confirmation...");
                        const latestBlockhash = await this.signer.connection.getLatestBlockhash();
                        await this.signer.connection.confirmTransaction(
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
        ], process.env.CLI_LISTEN_ADDRESS, parseInt(process.env.CLI_LISTEN_PORT));
    }

    init() {
        return this.cmdHandler.init().then(() => super.init());
    }

}