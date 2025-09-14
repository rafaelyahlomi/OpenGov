require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const readline = require('readline');

// --- Fixed configuration ---
const CONFIG = {
    polkadot: {
        ws: "wss://rpc.polkadot.io",
        token: "DOT",
        seed: process.env.POLKADOT_PROXY_SEED,
        conviction: 1,
        addresses: [
            "14zfiH2sMH955cG2yKUQbHSP3oQ8W4Ai9p9wSSZunvQ4TU4k",
            "16k5kPkBCMi89e1a9yGZGT4gHJW5H4KUQ5eVqPc8PGPxhi1K",
            "1ZXdGs6gFETHVTEW9RAZXwYxkDwAfE7wdt6czjBM4QRfMfk",
            "15B3UVXPRp3yS2gU7GogS41mwoT2fTL1KaNYPF7eMVjjWZJJ",
            "162tJdpDKWQZEwXEaNJKPSJiSyJtsv7wYGxYrreaTAXtvhK3",
            "13xa7rCYpABL4WvisHhzkwMtzKbEy8hoFDoXJU8efKqrCUPu"
        ],
        amounts: [24300, 13300, 14800, 2500, 9300, 1400] // DOT
    },
    kusama: {
        ws: "wss://kusama-rpc.polkadot.io",
        token: "KSM",
        seed: process.env.KUSAMA_PROXY_SEED,
        conviction: 1,
        addresses: [
            "GHewg8AxLL7JpRYDoqEyTk5bhGndhMvsDWo68St7D9YDH9Z",
            "Dr9QwogB1x5BH91L4ebVnW2c8ZV9oQDfCRk4RUja5bTQjtH",
            "Dz4kkGBhj8Z73rLetfignvS1k9VJspphWgBU3SgyYbd7wZJ",
            "EfGRcmd9Ew1NeKc6uMNjJm9gZJL5s91RTk6y3Z7YjMVRRqP",
            "HNasn6AEovA12ub2zf4pXSy5pEqyYxb9KnrfbHDBW3Fo6qx",
            "G53juiSZ3SKPVMHaHqxKsESgvJeKxn5RkcAFHaUHey3fcJB",
            "GLXvtF6k8UZ4eiohpCG537J6hLGuRidENNyWk9HMeC6a4P5"
        ],
        amounts: [50, 50, 300, 300, 250, 200, 200] // KSM
    }
};

// --- Helpers ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));
const getValidatedInput = async (q, fn) => {
    let input;
    while (true) {
        input = await ask(q);
        if (fn(input)) return input;
        console.log("❌ Invalid input. Please try again.");
    }
};

// --- Default voting logic ---
async function defaultVoting(api, cfg, proxyAccount) {
    const referendum = await ask("Enter referendum index: ");
    const voteSide = await ask("Vote type (aye/nay): ");
    const isAye = voteSide.toLowerCase() === "aye";

    console.log("\n📋 Voting Plan:");
    cfg.addresses.forEach((addr, i) => {
        console.log(
            `- ${addr}: ${isAye ? "AYE" : "NAY"}, ${cfg.amounts[i]} ${cfg.token}, conviction ${cfg.conviction}x`
        );
    });

    const confirm = await ask("Do you confirm broadcasting these votes? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
        console.log("❌ Cancelled.");
        process.exit(0);
    }

    for (let i = 0; i < cfg.addresses.length; i++) {
        const proxiedAccount = cfg.addresses[i];
        const balancePlancks = BigInt(cfg.amounts[i]) * BigInt(10 ** 12); // DOT/KSM = 12 decimals

        console.log(`\nVoting ${isAye ? "AYE" : "NAY"} on referendum ${referendum} for ${proxiedAccount}`);
        console.log(`Locking ${cfg.amounts[i]} ${cfg.token} with conviction ${cfg.conviction}x`);

        let voteTx;
        if (api.tx.democracy?.vote) {
            voteTx = api.tx.democracy.vote(referendum, { aye: isAye, conviction: `Locked${cfg.conviction}x` });
        } else if (api.tx.convictionVoting?.vote) {
            voteTx = api.tx.convictionVoting.vote(referendum, {
                Standard: {
                    vote: { aye: isAye, conviction: `Locked${cfg.conviction}x` },
                    balance: balancePlancks
                }
            });
        } else {
            console.error("❌ Voting method not found in the API.");
            continue;
        }

        const proxyVote = api.tx.proxy.proxy(proxiedAccount, 'Governance', voteTx);

        await new Promise(resolve => {
            proxyVote.signAndSend(proxyAccount, ({ status }) => {
                console.log(`Transaction status: ${status.type}`);
                if (status.isFinalized) {
                    console.log(`✅ Finalized in block: ${status.asFinalized}`);
                    resolve();
                }
            });
        });

        console.log("⏳ Waiting 5 seconds before next vote...");
        await new Promise(res => setTimeout(res, 5000));
    }

    console.log("\n✅ All default votes submitted.");
}

// --- Original custom voting logic (your first script condensed) ---
async function customVoting(api, proxyAccount, token) {
    const referendumsInput = await ask("Enter referendum indexes (comma-separated): ");
    const referendums = referendumsInput.split(',').map(r => r.trim());

    const voteTypes = {};
    const convictions = {};
    for (const referendum of referendums) {
        voteTypes[referendum] = await getValidatedInput(
            `Vote type for referendum ${referendum} (aye/nay): `,
            input => ["aye", "nay"].includes(input.toLowerCase())
        );
        convictions[referendum] = await getValidatedInput(
            `Conviction multiplier for referendum ${referendum} (1-6): `,
            input => !isNaN(input) && parseInt(input) >= 1 && parseInt(input) <= 6
        );
    }

    let firstProxiedAccount = true;
    const allVotes = [];

    while (true) {
        const proxiedAccount = await ask("Enter the proxied account address: ");
        console.log(`Voting on behalf of: ${proxiedAccount}`);

        let reuseReferendums = false;
        if (!firstProxiedAccount) {
            const reuseInput = await ask("Do you want to reuse the same referendums from the previous proxied account? (y/n): ");
            reuseReferendums = reuseInput.toLowerCase() === 'y';
        } else {
            firstProxiedAccount = false;
        }

        const useSameAmount = await ask(`Do you want to use the same amount of ${token} for all referendums? (y/n): `);
        let tokenAmounts = {};
        if (useSameAmount.toLowerCase() === 'y') {
            const amount = await getValidatedInput(`Enter ${token} amount to lock for all referendums: `, input => !isNaN(input) && Number(input) > 0);
            referendums.forEach(r => tokenAmounts[r] = amount);
        } else {
            for (const r of referendums) {
                tokenAmounts[r] = await getValidatedInput(
                    `Amount of ${token} to lock for referendum ${r}: `,
                    input => !isNaN(input) && Number(input) > 0
                );
            }
        }

        allVotes.push({ proxiedAccount, referendums, tokenAmounts });

        const addAnother = await ask("Do you want to add another proxied account? (y/n): ");
        if (addAnother.toLowerCase() !== 'y') break;
    }

    console.log("\nReview your votes before submission:");
    allVotes.forEach(({ proxiedAccount, tokenAmounts }, i) => {
        console.log(`\n[${i + 1}] Proxied Account: ${proxiedAccount}`);
        referendums.forEach(r => {
            console.log(
                `  Referendum ${r}: ${voteTypes[r].toUpperCase()}, ${tokenAmounts[r]} ${token}, Conviction ${convictions[r]}x`
            );
        });
    });

    const confirmation = await ask("Do you confirm broadcasting these votes? (y/n): ");
    if (confirmation.toLowerCase() !== 'y') {
        console.log("❌ Transaction cancelled.");
        rl.close();
        process.exit(0);
    }

    console.log("\nStarting voting process...");
    for (const { proxiedAccount, tokenAmounts } of allVotes) {
        for (const r of referendums) {
            console.log(`\nVoting ${voteTypes[r].toUpperCase()} on referendum ${r} for ${proxiedAccount}`);
            console.log(`Locking ${tokenAmounts[r]} ${token} with conviction ${convictions[r]}x`);

            const balancePlancks = BigInt(tokenAmounts[r]) * BigInt(10 ** 12);
            let voteTx;
            if (api.tx.democracy?.vote) {
                voteTx = api.tx.democracy.vote(r, { aye: voteTypes[r] === 'aye', conviction: `Locked${convictions[r]}x` });
            } else if (api.tx.convictionVoting?.vote) {
                voteTx = api.tx.convictionVoting.vote(r, {
                    Standard: { vote: { aye: voteTypes[r] === 'aye', conviction: `Locked${convictions[r]}x` }, balance: balancePlancks }
                });
            } else {
                console.error("❌ Voting method not found in the API.");
                continue;
            }

            const proxyVote = api.tx.proxy.proxy(proxiedAccount, 'Governance', voteTx);
            await new Promise(resolve => {
                proxyVote.signAndSend(proxyAccount, ({ status }) => {
                    console.log(`Transaction status: ${status.type}`);
                    if (status.isFinalized) {
                        console.log(`✅ Finalized in block: ${status.asFinalized}`);
                        resolve();
                    }
                });
            });

            console.log("⏳ Waiting 5 seconds before next vote...");
            await new Promise(res => setTimeout(res, 5000));
        }
    }

    console.log("✅ All votes submitted.");
}

// --- Main entrypoint ---
async function main() {
    const useDefault = (await ask("Do you want to use the default (pre-set addresses/amounts)? (y/n): ")).toLowerCase() === "y";
    const networkChoice = (await ask("Select network (polkadot/kusama): ")).toLowerCase();
    const cfg = CONFIG[networkChoice];
    if (!cfg) {
        console.log("❌ Invalid network");
        process.exit(1);
    }

    // Connect
    const wsProvider = new WsProvider(cfg.ws);
    const api = await ApiPromise.create({ provider: wsProvider });
    const keyring = new Keyring({ type: 'sr25519' });
    const proxyAccount = keyring.addFromUri(cfg.seed);

    console.log(`✅ Using Proxy Account: ${proxyAccount.address} on ${networkChoice.toUpperCase()}`);

    if (useDefault) {
        await defaultVoting(api, cfg, proxyAccount);
    } else {
        await customVoting(api, proxyAccount, cfg.token);
    }

    rl.close();
}

main().catch(err => {
    console.error("❌ Error:", err);
    rl.close();
});
