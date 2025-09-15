require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const readline = require('readline');
const fs = require('fs');

// --- Load description.json ---
const DESCRIPTION = JSON.parse(fs.readFileSync('./description.json', 'utf8'));

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

// --- Default voting preparation ---
async function defaultVotingPrepare(cfg) {
    const referendumsInput = await ask("Enter referendum indexes (comma-separated): ");
    const referendums = referendumsInput.split(",").map(r => r.trim());

    const voteTypes = {};
    for (const r of referendums) {
        voteTypes[r] = await getValidatedInput(
            `Vote type for referendum ${r} (aye/nay): `,
            input => ["aye", "nay"].includes(input.toLowerCase())
        );
    }

    const allVotes = [];
    for (const acc of cfg.addresses) {
        const tokenAmounts = {};
        referendums.forEach(r => tokenAmounts[r] = acc.amount);
        allVotes.push({ proxiedAccount: acc.address, referendums, tokenAmounts, conviction: acc.conviction });
    }

    console.log("\n📋 Review your votes before submission:");
    allVotes.forEach(({ proxiedAccount, tokenAmounts, conviction }, idx) => {
        console.log(`\n[${idx + 1}] Proxied Account: ${proxiedAccount}`);
        referendums.forEach(r => {
            console.log(
                `  Referendum ${r}: ${voteTypes[r].toUpperCase()}, ${tokenAmounts[r]} ${cfg.token}, Conviction ${conviction}x`
            );
        });
    });

    const confirmation = await ask("Do you confirm broadcasting these votes? (y/n): ");
    if (confirmation.toLowerCase() !== "y") {
        console.log("❌ Cancelled.");
        process.exit(0);
    }

    return { allVotes, voteTypes, referendums };
}

// --- Custom voting preparation ---
async function customVotingPrepare(api, proxyAccount, token) {
    const referendumsInput = await ask("Enter referendum indexes (comma-separated): ");
    const referendums = referendumsInput.split(',').map(r => r.trim());

    const voteTypes = {};
    const convictions = {};
    for (const r of referendums) {
        voteTypes[r] = await getValidatedInput(
            `Vote type for referendum ${r} (aye/nay): `,
            input => ["aye", "nay"].includes(input.toLowerCase())
        );
        convictions[r] = await getValidatedInput(
            `Conviction multiplier for referendum ${r} (1-6): `,
            input => !isNaN(input) && parseInt(input) >= 1 && parseInt(input) <= 6
        );
    }

    const allVotes = [];
    while (true) {
        const proxiedAccount = await ask("Enter the proxied account address: ");
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

        allVotes.push({ proxiedAccount, referendums, tokenAmounts, conviction: convictions });

        const addAnother = await ask("Do you want to add another proxied account? (y/n): ");
        if (addAnother.toLowerCase() !== 'y') break;
    }

    console.log("\n📋 Review your votes before submission:");
    allVotes.forEach(({ proxiedAccount, tokenAmounts, conviction }, i) => {
        console.log(`\n[${i + 1}] Proxied Account: ${proxiedAccount}`);
        referendums.forEach(r => {
            console.log(
                `  Referendum ${r}: ${voteTypes[r].toUpperCase()}, ${tokenAmounts[r]} ${token}, Conviction ${conviction[r]}x`
            );
        });
    });

    const confirmation = await ask("Do you confirm broadcasting these votes? (y/n): ");
    if (confirmation.toLowerCase() !== 'y') {
        console.log("❌ Transaction cancelled.");
        process.exit(0);
    }

    return { allVotes, voteTypes, referendums };
}

// --- Main entrypoint ---
async function main() {
    const useDefault = (await ask("Do you want to use the default (pre-set addresses/amounts)? (y/n): ")).toLowerCase() === "y";
    const networkChoice = (await ask("Select network (polkadot/kusama): ")).toLowerCase();
    const cfg = DESCRIPTION[networkChoice];
    if (!cfg) {
        console.log("❌ Invalid network");
        process.exit(1);
    }

    // Load seed from .env
    const seed = process.env[cfg.seed_env];
    if (!seed) {
        console.error(`❌ Missing seed for ${networkChoice}. Set ${cfg.seed_env} in .env`);
        process.exit(1);
    }

    // Connect
    const wsProvider = new WsProvider(cfg.ws);
    const api = await ApiPromise.create({ provider: wsProvider });
    const keyring = new Keyring({ type: 'sr25519' });
    const proxyAccount = keyring.addFromUri(seed);
    console.log(`✅ Using Proxy Account: ${proxyAccount.address} on ${networkChoice.toUpperCase()}`);

    let allVotes, voteTypes, referendums;
    if (useDefault) {
        ({ allVotes, voteTypes, referendums } = await defaultVotingPrepare(cfg));
    } else {
        ({ allVotes, voteTypes, referendums } = await customVotingPrepare(api, proxyAccount, cfg.token));
    }

    // --- Broadcasting ---
    console.log("\n🚀 Starting broadcasting...");
    for (const { proxiedAccount, tokenAmounts, conviction } of allVotes) {
        for (const r of referendums) {
            const cv = typeof conviction === "object" ? conviction[r] : conviction;
            console.log(`\nVoting ${voteTypes[r].toUpperCase()} on referendum ${r} for ${proxiedAccount}`);
            console.log(`Locking ${tokenAmounts[r]} ${cfg.token} with conviction ${cv}x`);

            const balancePlancks = BigInt(tokenAmounts[r]) * BigInt(10 ** 10);
            let voteTx;

            if (api.tx.democracy?.vote) {
                voteTx = api.tx.democracy.vote(r, { aye: voteTypes[r] === 'aye', conviction: `Locked${cv}x` });
            } else if (api.tx.convictionVoting?.vote) {
                voteTx = api.tx.convictionVoting.vote(r, {
                    Standard: { vote: { aye: voteTypes[r] === 'aye', conviction: `Locked${cv}x` }, balance: balancePlancks }
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
    rl.close();
}

main().catch(err => {
    console.error("❌ Error:", err);
    rl.close();
});
