require('babel-register');
require('babel-polyfill');
require('dotenv').config();

const HDWalletProvider = require("@truffle/hdwallet-provider") 

const privateKeys = process.env.PRIVATE_KEYS || ""

const maticmainnet_rpc_url = 'wss://polygon-mainnet.g.alchemy.com/v2/https://rpc-mainnet.matic.network'
const maticmumbai_rpc_url = 'https://rpc-mumbai.matic.today'


module.exports = {
  networks: {
    development: {
      host: "127.0.0.1",
      port: 7545,
      network_id: "*" // Match any network id
    }
  },
  maticmainnet: {
    provider: function() {
        return new HDWalletProvider(privateKeys, maticmainnet_rpc_url);
      },
      network_id: '137',
  },
  maticmumbai: {
    provider: function() {
        return new HDWalletProvider(privateKeys, maticmumbai_rpc_url);
      },
      network_id: '80001',
  },

compilers: {
solc: {
version: '0.8.9',
optimizer: {
enabled: true,
runs: 200
      }
    }
  },
};