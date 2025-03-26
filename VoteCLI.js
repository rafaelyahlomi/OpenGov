require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const readline = require('readline');

// Set up readline interface for interactive input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const NETWORKS = {
    polkadot: { ws: "wss://rpc.polkadot.io", proxySeed: process.env.POLKADOT_PROXY_SEED, token: "DOT" },
    kusama: { ws: "wss://kusama-rpc.polkadot.io", proxySeed: process.env.KUSAMA_PROXY_SEED, token: "KSM" }
};

async function askQuestion(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function getValidatedInput(question, validateFn) {
    let input;
    while (true) {
        input = await askQuestion(question);
        if (validateFn(input)) break;
        console.log("❌ Invalid input. Please try again.");
    }
    return input;
}

async function main() {
    const networkChoice = await getValidatedInput("Select network (polkadot/kusama): ", input => ["polkadot", "kusama"].includes(input.toLowerCase()));
    const selectedNetwork = NETWORKS[networkChoice];

    const wsProvider = new WsProvider(selectedNetwork.ws);
    const api = await ApiPromise.create({ provider: wsProvider });
    const keyring = new Keyring({ type: 'sr25519' });

    if (!selectedNetwork.proxySeed) {
        console.error(`❌ Proxy seed for ${networkChoice} is missing. Please check your .env file.`);
        process.exit(1);
    }

    const proxyAccount = keyring.addFromUri(selectedNetwork.proxySeed.trim());
    console.log(`Using Proxy Account: ${proxyAccount.address}`);

    // Step 1: Collect referendums
    const referendumsInput = await askQuestion("Enter referendum indexes (comma-separated): ");
    const referendums = referendumsInput.split(',').map(r => r.trim());

    // Step 2: Ask vote type per referendum
    const voteTypes = {};
    for (const referendum of referendums) {
        voteTypes[referendum] = await getValidatedInput(
            `Vote type for referendum ${referendum} (aye/nay): `,
            input => ["aye", "nay"].includes(input.toLowerCase())
        );
    }

    // Step 3: Ask conviction per referendum
    const convictions = {};
    for (const referendum of referendums) {
        convictions[referendum] = await getValidatedInput(
            `Conviction multiplier for referendum ${referendum} (1-6): `,
            input => !isNaN(input) && parseInt(input) >= 1 && parseInt(input) <= 6
        );
    }

    // Step 4 & 5: Ask for proxied accounts and token amount per referendum
    const allVotes = [];
    while (true) {
        const proxiedAccount = await askQuestion("Enter the proxied account address: ");
        console.log(`Voting on behalf of: ${proxiedAccount}`);

        const useSameAmount = await askQuestion(`Do you want to use the same amount of ${selectedNetwork.token} for all referendums? (y/n): `);
        let tokenAmounts = {};
        if (useSameAmount.toLowerCase() === 'y') {
            const amount = await getValidatedInput(`Enter ${selectedNetwork.token} amount to lock for all referendums: `, input => !isNaN(input) && Number(input) > 0);
            referendums.forEach(referendum => tokenAmounts[referendum] = amount);
        } else {
            for (const referendum of referendums) {
                tokenAmounts[referendum] = await getValidatedInput(
                    `Enter ${selectedNetwork.token} amount to lock for referendum ${referendum}: `,
                    input => !isNaN(input) && Number(input) > 0
                );
            }
        }

        allVotes.push({ proxiedAccount, tokenAmounts });

        const addAnother = await askQuestion("Do you want to add another proxied account? (y/n): ");
        if (addAnother.toLowerCase() !== 'y') break;
    }

    console.log("\nReview your votes before submission:");
    allVotes.forEach(({ proxiedAccount, tokenAmounts }, i) => {
        console.log(`\n[${i + 1}] Proxied Account: ${proxiedAccount}`);
        referendums.forEach(referendum => {
            console.log(
                `  Referendum ${referendum}: ${voteTypes[referendum].toUpperCase()}, ` +
                `${tokenAmounts[referendum]} ${selectedNetwork.token}, Conviction ${convictions[referendum]}x`
            );
        });
    });

    const confirmation = await askQuestion("Do you confirm broadcasting these votes? (y/n): ");
    if (confirmation.toLowerCase() !== 'y') {
        console.log("❌ Transaction cancelled.");
        rl.close();
        process.exit(0);
    }

    console.log("\nStarting voting process...");
    for (const { proxiedAccount, tokenAmounts } of allVotes) {
        for (const referendum of referendums) {
            console.log(`\nVoting ${voteTypes[referendum].toUpperCase()} on referendum ${referendum} for ${proxiedAccount}`);
            console.log(`Locking ${tokenAmounts[referendum]} ${selectedNetwork.token} with conviction ${convictions[referendum]}x`);

            const balancePlancks = BigInt(tokenAmounts[referendum]) * BigInt(10 ** 10);
            let voteTx;

            if (api.tx.democracy?.vote) {
                voteTx = api.tx.democracy.vote(referendum, { aye: voteTypes[referendum] === 'aye', conviction: convictions[referendum] });
            } else if (api.tx.convictionVoting?.vote) {
                voteTx = api.tx.convictionVoting.vote(referendum, { Standard: { vote: { aye: voteTypes[referendum] === 'aye', conviction: convictions[referendum] }, balance: balancePlancks } });
            } else {
                console.error("❌ Voting method not found in the API.");
                continue;
            }

            const proxyVote = api.tx.proxy.proxy(proxiedAccount, 'Governance', voteTx);
            await new Promise((resolve) => {
                proxyVote.signAndSend(proxyAccount, ({ status }) => {
                    console.log(`Transaction status: ${status.type}`);
                    if (status.isFinalized) {
                        console.log(`✅ Finalized in block: ${status.asFinalized}`);
                        resolve();
                    }
                });
            });

            console.log("⏳ Waiting 10 seconds before next vote...");
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }

    console.log("✅ All votes submitted.");
    rl.close();
}

main().catch(error => {
    console.error("❌ Error occurred:", error);
    rl.close();
});
