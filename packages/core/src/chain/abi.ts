import { parseAbi } from 'viem';

export const factoryAbi = parseAbi([
  'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address transistors, address circuits)',
  'function cpuCount() view returns (uint256)',
  'function cpuAt(uint256) view returns (address)',
  'function isCPU(address) view returns (bool)',
  'function deployFee() view returns (uint256)',
  'event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice)',
]);

export const processorAbi = parseAbi([
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256 id)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function nextId() view returns (uint256)',
  'function circuitInfo(uint256) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function netlist(uint256) view returns (bytes)',
  'function eval(uint256, bytes) view returns (bytes)',
  'function step(uint256, bytes, bytes) view returns (bytes newState, bytes outputs)',
  'function transistors() view returns (address)',
  'function name() view returns (string)',
  'function ownerOf(uint256) view returns (address)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
]);

export const transistorsAbi = parseAbi([
  'function mint(uint256 id, uint256 amount) payable',
  'function mintPrice() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'function supplyCap() view returns (uint256)',
  'function minted() view returns (uint256)',
  'function balanceOf(address, uint256) view returns (uint256)',
]);

export const openerAbi = parseAbi([
  'function accountOf(address, uint256) view returns (address)',
  'function isOpened(address, uint256) view returns (bool)',
  'function open(address, uint256) payable returns (address)',
  'function FEE() view returns (uint256)',
]);

export const siteRegistryAbi = parseAbi([
  'function fileInfo(address, string) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)',
  'function pathCount(address) view returns (uint256)',
  'function pathsRange(address, uint256, uint256) view returns (string[])',
  'function putFile(address, string, string, bytes32, bytes)',
  'function appendChunk(address, string, uint256, bytes)',
  'function removeFile(address, string)',
]);

export const domainBindingAbi = parseAbi([
  'function monthlyFee() view returns (uint256)',
  'function isContainerLive(address) view returns (bool)',
  'function bind(string name, address container, uint256 months) payable',
]);
