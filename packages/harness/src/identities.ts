// Deterministic identity minting now lives in the platform-free shared rig
// (@bolusi/test-support/chaos, task 181). Re-exported unchanged — the Node and on-device rigs mint
// byte-identical identities from the same seed (T-6).
export { mintIdentities, type RunIdentities } from '@bolusi/test-support/chaos';
