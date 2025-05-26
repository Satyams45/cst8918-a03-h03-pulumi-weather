import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure-native";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as containerinstance from "@pulumi/azure-native/containerinstance";
import * as resources from "@pulumi/azure-native/resources";

// Pulumi config
const config = new pulumi.Config();
const weatherApiKey = config.requireSecret("weatherApiKey");
const imageTag = config.require("imageTag"); // e.g., "v0.3.0"
const prefixName = pulumi.getProject();

// Resource Group
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`, {
  location: "westus3",
});

// Valid, unique ACR name (alphanumeric only, lowercase, max 50 characters)
const acrName = `${prefixName}acr${pulumi.getStack()}`.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().substring(0, 50);


const registry = new containerregistry.Registry(acrName, {
  registryName: acrName,
  resourceGroupName: resourceGroup.name,
  location: resourceGroup.location,
  sku: {
    name: "Basic",
  },
  adminUserEnabled: true,
});

// ACR credentials
const creds = pulumi
  .all([registry.name, resourceGroup.name])
  .apply(([name, rg]) =>
    containerregistry.listRegistryCredentials({ registryName: name, resourceGroupName: rg })
  );

const adminUsername = creds.apply(c => c.username!);
const adminPassword = creds.apply(c => c.passwords![0].value!);
const loginServer = registry.loginServer;

// Redis instance
const redis = new azure.redis.Redis(`${prefixName}-redis`, {
  name: `${prefixName}-weather-cache`,
  location: resourceGroup.location,
  resourceGroupName: resourceGroup.name,
  enableNonSslPort: true,
  redisVersion: "6",
  minimumTlsVersion: "1.2",
  redisConfiguration: {
    maxmemoryPolicy: "allkeys-lru",
  },
  sku: {
    name: "Basic",
    family: "C",
    capacity: 0,
  },
});

// Redis connection string
const redisAccessKey = azure.redis.listRedisKeysOutput({
  name: redis.name,
  resourceGroupName: resourceGroup.name,
}).apply(keys => keys.primaryKey);

const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redis.hostName}:${redis.sslPort}`;

// Container instance with Redis and weather API key
const containerGroup = new containerinstance.ContainerGroup(`${prefixName}-cg`, {
  resourceGroupName: resourceGroup.name,
  location: resourceGroup.location,
  osType: "Linux",
  containers: [{
    name: "weather-app",
image: pulumi.interpolate`${registry.loginServer}/cst8918-a03-infra-weather:${imageTag}`,
    resources: {
      requests: {
        cpu: 0.5,
        memoryInGB: 1,
      },
    },
    ports: [{ port: 80 }], // Make sure port matches ACI exposed port
    environmentVariables: [
      {
        name: "WEATHER_API_KEY",
        secureValue: weatherApiKey,
      },
      {
        name: "REDIS_URL",
        value: redisConnectionString,
      },
    ],
  }],
  imageRegistryCredentials: [{
    server: loginServer,
    username: adminUsername,
    password: adminPassword,
  }],
  restartPolicy: "Always",
  ipAddress: {
    type: "Public",
    ports: [{ port: 80, protocol: "Tcp" }],
  },
});

// Export the app URL
export const appUrl = containerGroup.ipAddress.apply(ip => ip && ip.ip ? `http://${ip.ip}` : "No public IP assigned");
