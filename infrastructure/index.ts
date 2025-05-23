import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as dockerBuild from "@pulumi/docker-build";
import * as containerinstance from "@pulumi/azure-native/containerinstance";
import {
  Redis,
  SkuName,
  listRedisKeysOutput
} from "@pulumi/azure-native/redis";

// Config values
const config = new pulumi.Config();
const appPath = config.require("appPath");
const prefixName = config.require("prefixName");
const imageName = prefixName;
const imageTag = config.require("imageTag");
const containerPort = config.requireNumber("containerPort");
const publicPort = config.requireNumber("publicPort");
const cpu = config.requireNumber("cpu");
const memory = config.requireNumber("memory");

// Resource group
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`);

// Container registry
const registry = new containerregistry.Registry(`${prefixName}ACR`, {
  resourceGroupName: resourceGroup.name,
  adminUserEnabled: true,
  sku: { name: containerregistry.SkuName.Basic },
});

// Registry credentials
const registryCredentials = containerregistry
  .listRegistryCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    registryName: registry.name,
  })
  .apply((creds) => ({
    username: creds.username!,
    password: creds.passwords![0].value!,
  }));

// Redis instance
const redis = new Redis(`${prefixName}-redis`, {
  name: `${prefixName}-weather-cache`,
  location: "westus3",
  resourceGroupName: resourceGroup.name,
  enableNonSslPort: true,
  redisVersion: "Latest",
  minimumTlsVersion: "1.2",
  redisConfiguration: {
    maxmemoryPolicy: "allkeys-lru",
  },
  sku: {
    name: SkuName.Basic,
    family: "C",
    capacity: 0,
  },
});

// Redis access key
const redisAccessKey = listRedisKeysOutput({
  name: redis.name,
  resourceGroupName: resourceGroup.name,
}).apply((keys) => keys.primaryKey);

// Redis connection string
const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redis.hostName}:${redis.sslPort}`;

// Docker image build
const image = new dockerBuild.Image(`${prefixName}-image`, {
  tags: [pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`],
  context: { location: appPath },
  dockerfile: { location: `${appPath}/Dockerfile` },
  target: "production",
  platforms: ["linux/amd64", "linux/arm64"],
  push: true,
  registries: [
    {
      address: registry.loginServer,
      username: registryCredentials.username,
      password: registryCredentials.password,
    },
  ],
});

// Unique DNS name to avoid collision
const dnsNameLabel = `${imageName}-${Date.now()}`;

// Container group deployment
const containerGroup = new containerinstance.ContainerGroup(
  `${prefixName}-container-group`,
  {
    resourceGroupName: resourceGroup.name,
    osType: "linux",
    restartPolicy: "always",
    imageRegistryCredentials: [
      {
        server: registry.loginServer,
        username: registryCredentials.username,
        password: registryCredentials.password,
      },
    ],
    containers: [
      {
        name: imageName,
        image: image.ref,
        ports: [{ port: containerPort, protocol: "tcp" }],
        environmentVariables: [
          {
            name: "PORT",
            value: containerPort.toString(),
          },
          {
            name: "WEATHER_API_KEY",
            value: config.requireSecret("weatherApiKey"),
          },
          {
            name: "REDIS_URL",
            value: redisConnectionString,
          },
        ],
        resources: {
          requests: {
            cpu: cpu,
            memoryInGB: memory,
          },
        },
      },
    ],
    ipAddress: {
      type: containerinstance.ContainerGroupIpAddressType.Public,
      dnsNameLabel: dnsNameLabel,
      ports: [{ port: publicPort, protocol: "tcp" }],
    },
  }
);

// Outputs
export const hostname = containerGroup.ipAddress.apply((addr) => addr!.fqdn!);
export const ip = containerGroup.ipAddress.apply((addr) => addr!.ip!);
export const url = containerGroup.ipAddress.apply((addr) => `http://${addr!.fqdn!}:${containerPort}`);
