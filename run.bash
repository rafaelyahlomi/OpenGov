#Step 1: Install NVM
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
source ~/.bashrc

#Step 2: Install Node.js
nvm install --lts
node -v
npm -v

#Step 3: Install dotenv
npm install dotenv
npm install @polkadot/api

# Step 4: Create .env file and store seed-phrase as follow
sudo nano .env
POLKADOT_PROXY_SEED="your-polkadot-proxy-seed"
KUSAMA_PROXY_SEED="your-kusama-proxy-seed"

#Step 5: Retrieve VoteCLI file and give permission
wget -O VoteCLI https://raw.githubusercontent.com/legendnodes/OpenGov/main/VoteCLI.js
chmod +x VoteCLI

# Step 6: Run the process
node VoteCLI



