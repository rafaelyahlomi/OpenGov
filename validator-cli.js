#!/usr/bin/env node
const { ApiPromise, WsProvider } = require('@polkadot/api');
const fs = require('fs');
const path = require('path');

// Default configuration
const DEFAULT_CONFIG = {
    providers: [
        'wss://rpc.polkadot.io',
        'wss://polkadot-rpc.dwellir.com',
        'wss://polkadot.api.onfinality.io/public-ws'
    ],
    batchSize: 25,
    maxValidators: 100,
    cacheFile: './validator-cache.json',
    cacheTimeout: 3600000, // 1 hour
    testValidator: '14zfiH2sMH955cG2yKUQbHSP3oQ8W4Ai9p9wSSZunvQ4TU4k'
};

// Parse command-line arguments
const args = process.argv.slice(2);
const options = {
    limit: null,
    validator: null,
    refresh: false,
    help: false
};

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
        options.help = true;
    } else if (arg === '--limit' || arg === '-l') {
        options.limit = parseInt(args[++i], 10);
    } else if (arg === '--validator' || arg === '-v') {
        options.validator = args[++i];
    } else if (arg === '--refresh' || arg === '-r') {
        options.refresh = true;
    }
}

if (options.help) {
    console.log(`
Polkadot Validator Data CLI

Usage:
  node validator-cli.js [options]

Options:
  -h, --help       Show this help message
  -l, --limit N    Limit the number of validators to process (default: 100)
  -v, --validator  Specific validator address to analyze
  -r, --refresh    Force refresh data (ignore cache)

Examples:
  # Show top 10 validators
  node validator-cli.js --limit 10
  
  # Analyze a specific validator
  node validator-cli.js --validator 14zfiH2sMH955cG2yKUQbHSP3oQ8W4Ai9p9wSSZunvQ4TU4k
  
  # Force cache refresh
  node validator-cli.js --refresh
    `);
    process.exit(0);
}

// Cache helper functions
function loadCache() {
    try {
        if (fs.existsSync(DEFAULT_CONFIG.cacheFile) && !options.refresh) {
            const cacheData = JSON.parse(fs.readFileSync(DEFAULT_CONFIG.cacheFile, 'utf8'));
            const now = Date.now();
            
            // Check if cache is still valid
            if (now - cacheData.timestamp < DEFAULT_CONFIG.cacheTimeout) {
                return cacheData.data;
            }
        }
    } catch (error) {
        console.error('Error loading cache:', error.message);
    }
    return null;
}

function saveCache(data) {
    try {
        const cacheData = {
            timestamp: Date.now(),
            data: data
        };
        fs.writeFileSync(DEFAULT_CONFIG.cacheFile, JSON.stringify(cacheData, null, 2));
        console.log('Cache saved successfully');
    } catch (error) {
        console.error('Error saving cache:', error.message);
    }
}

async function connectToNetwork() {
    for (const endpoint of DEFAULT_CONFIG.providers) {
        try {
            console.log(`Attempting to connect to ${endpoint}...`);
            const provider = new WsProvider(endpoint, 60000);
            const api = await ApiPromise.create({ provider });
            console.log(`Successfully connected to ${endpoint}`);
            return api;
        } catch (err) {
            console.log(`Failed to connect to ${endpoint}: ${err.message}`);
        }
    }
    throw new Error('Failed to connect to any Polkadot endpoint');
}

async function processValidatorsBatch(api, validators, eraNumber, nominatorsMap) {
    console.log(`Processing batch of ${validators.length} validators...`);
    
    return Promise.all(validators.map(async (validator) => {
        try {
            const validatorAddress = validator.toString();
            const isTestValidator = validatorAddress === DEFAULT_CONFIG.testValidator;
            
            // Get validator preferences (fees)
            const prefs = await api.query.staking.validators(validator);
            
            // Get staking info for the validator
            const stakingInfo = await api.derive.staking.account(validator);
            
            // Filter nominators that target this validator
            const targetingNominators = [];
            for (const [nominator, targets] of Object.entries(nominatorsMap)) {
                if (targets.includes(validatorAddress)) {
                    targetingNominators.push(nominator);
                }
            }
            
            // Get the exposure data from the current era
            const exposure = await api.query.staking.erasStakers(eraNumber, validator);
            
            // Get self stake, commission, etc.
            const selfBond = stakingInfo?.stakingLedger?.total || '0';
            const ownStake = Number(selfBond) / 1e10; // Convert to DOT
            const commission = prefs?.commission.toNumber() || 0;
            const commissionPct = commission / 10000000;
            
            // Process the exposure data
            const exposureData = exposure.toJSON();
            
            // Get active stake from exposure (this is what's actually staked on the network)
            const activeStake = exposureData.others.reduce((sum, other) => {
                return sum + Number(other.value) / 1e10;
            }, 0);
            
            // Calculate inactive nominations
            const activeNominatorCount = exposureData.others.length;
            const totalNominatorCount = targetingNominators.length;
            const inactiveNominatorCount = Math.max(0, totalNominatorCount - activeNominatorCount);
            
            // Improved inactive stake estimation
            let inactiveStake = 0;
            if (activeNominatorCount > 0 && inactiveNominatorCount > 0) {
                const avgActiveStakePerNominator = activeStake / activeNominatorCount;
                
                // Apply different multipliers based on commission and other factors
                let inactiveMultiplier = 0.7; // Base value
                
                // Validators with lower commission likely have more competition for active slots
                if (commissionPct < 5) {
                    inactiveMultiplier = 0.6;
                } else if (commissionPct > 15) {
                    inactiveMultiplier = 0.8;
                }
                
                inactiveStake = avgActiveStakePerNominator * inactiveMultiplier * inactiveNominatorCount;
            }
            
            // Calculate total nomination and total active stake
            const totalNomination = activeStake + inactiveStake;
            const totalActiveStake = ownStake + activeStake;
            
            return {
                'Validator': validatorAddress,
                'Self Bond (DOT)': ownStake.toFixed(4),
                'Active Nomination (DOT)': activeStake.toFixed(4),
                'Inactive Nomination (DOT)': inactiveStake.toFixed(4),
                'Total Nomination (DOT)': totalNomination.toFixed(4),
                'Total Active Stake (DOT)': totalActiveStake.toFixed(4),
                'Commission (%)': commissionPct.toFixed(2),
                'Nominators (Active/Total)': `${activeNominatorCount}/${totalNominatorCount}`
            };
        } catch (err) {
            console.error(`Error processing validator ${validator.toString()}:`, err.message);
            return {
                'Validator': validator.toString(),
                'Self Bond (DOT)': '0.00',
                'Active Nomination (DOT)': '0.00',
                'Inactive Nomination (DOT)': '0.00',
                'Total Nomination (DOT)': '0.00',
                'Total Active Stake (DOT)': '0.00',
                'Commission (%)': '0.00',
                'Nominators (Active/Total)': '0/0'
            };
        }
    }));
}

async function getValidators() {
    let api;
    try {
        // Check cache first
        const cachedData = loadCache();
        if (cachedData) {
            console.log('Using cached validator data');
            
            // If a specific validator is requested, filter the results
            if (options.validator) {
                const validatorData = cachedData.find(v => v.Validator === options.validator);
                if (validatorData) {
                    console.log('\nValidator Information:');
                    console.table([validatorData]);
                } else {
                    console.log(`Validator ${options.validator} not found in cache. Use --refresh to update data.`);
                }
                return;
            }
            
            // Apply limit if specified
            const displayData = options.limit ? cachedData.slice(0, options.limit) : cachedData;
            console.table(displayData);
            return;
        }
        
        // Connect to Polkadot network
        api = await connectToNetwork();
        
        // If a specific validator is requested
        if (options.validator) {
            // Try to decode the address
            try {
                // Get active era
                const activeEra = await api.query.staking.activeEra();
                const eraNumber = activeEra.unwrap().index.toString();
                console.log('Active Era:', eraNumber);
                
                // Get all nominators data
                console.log('Loading nominators data...');
                const nominatorsData = await api.query.staking.nominators.entries();
                console.log(`Found ${nominatorsData.length} total nominators on the network`);
                
                // Create map of nominator => targets for quick lookup
                const nominatorsMap = {};
                for (const [key, nominations] of nominatorsData) {
                    try {
                        const nominator = key.args[0].toString();
                        const targets = nominations.unwrap().targets.map(t => t.toString());
                        nominatorsMap[nominator] = targets;
                    } catch (err) {
                        // Skip problematic nominators
                    }
                }
                
                // Process the single validator
                const results = await processValidatorsBatch(api, [options.validator], eraNumber, nominatorsMap);
                console.log('\nValidator Information:');
                console.table(results);
                
                // Save to cache
                saveCache(results);
            } catch (err) {
                console.error(`Error processing validator ${options.validator}:`, err.message);
            }
            return;
        }
        
        // Get the current validators
        const validators = await api.query.session.validators();
        console.log(`Found ${validators.length} active validators`);
        
        // Get active era
        const activeEra = await api.query.staking.activeEra();
        const eraNumber = activeEra.unwrap().index.toString();
        console.log('Active Era:', eraNumber);
        
        // Set maximum validators to process
        const maxValidators = options.limit || DEFAULT_CONFIG.maxValidators;
        
        // Limit validators if needed
        const processValidators = maxValidators
            ? validators.slice(0, maxValidators)
            : validators;

        // Pre-load all nominators data for efficiency
        console.log('Loading nominators data...');
        const nominatorsData = await api.query.staking.nominators.entries();
        console.log(`Found ${nominatorsData.length} total nominators on the network`);
        
        // Create map of nominator => targets for quick lookup
        const nominatorsMap = {};
        for (const [key, nominations] of nominatorsData) {
            try {
                const nominator = key.args[0].toString();
                const targets = nominations.unwrap().targets.map(t => t.toString());
                nominatorsMap[nominator] = targets;
            } catch (err) {
                // Skip problematic nominators
            }
        }
        
        // Process validators in batches to avoid timeout
        let results = [];
        for (let i = 0; i < processValidators.length; i += DEFAULT_CONFIG.batchSize) {
            const batch = processValidators.slice(i, i + DEFAULT_CONFIG.batchSize);
            console.log(`Processing batch ${i/DEFAULT_CONFIG.batchSize + 1} of ${Math.ceil(processValidators.length/DEFAULT_CONFIG.batchSize)}`);
            
            const batchResults = await processValidatorsBatch(api, batch, eraNumber, nominatorsMap);
            results = results.concat(batchResults);
            
            console.log(`Completed batch ${i/DEFAULT_CONFIG.batchSize + 1}`);
        }
        
        // Sort results by total active stake (descending)
        results.sort((a, b) => 
            parseFloat(b['Total Active Stake (DOT)']) - parseFloat(a['Total Active Stake (DOT)'])
        );
        
        console.log('\nPolkadot Validators Information:');
        
        // Apply limit if specified
        const displayData = options.limit ? results.slice(0, options.limit) : results;
        console.table(displayData);
        
        // Save results to cache
        saveCache(results);
        
    } catch (error) {
        console.error('Error fetching validators:', error);
    } finally {
        // Disconnect from the network
        if (api) {
            console.log('Disconnecting from network...');
            await api.disconnect();
            console.log('Disconnected successfully');
        }
    }
}

// Run the function
getValidators();