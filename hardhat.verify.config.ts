import config from "./hardhat.config.ts";

// Source verification needs public RPC access and no deployment credential.
const verificationConfig = {
  ...config,
  networks: {
    ...config.networks,
    hemi: { ...config.networks!.hemi, accounts: [] },
  },
};

export default verificationConfig;
