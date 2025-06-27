
const { BlobServiceClient } = require('@azure/storage-blob');
require('dotenv').config();

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

if (!connectionString) {
  throw new Error('Azure Storage Connection String is not set in .env file');
}

const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

console.log('Azure Blob Storage service client initialized successfully.');

module.exports = {
  blobServiceClient
};
