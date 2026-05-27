/** Wire shape from POST /api/store-file/prepare (quote field). */
export interface UploadQuote {
  sealedPayloadBytes: number;
  plainPayloadBytes: number;
  sourceFileBytes: number;
  binary: boolean;
  leaseSeconds: number;
  leaseLabel: string;
  expiresAbout: string;
  storageByteSeconds: string;
  txGasMaxWei: string;
  txGasMaxGlm: string;
  storageEstimateWei: string | null;
  storageEstimateGlm: string | null;
  totalEstimateWei: string;
  totalEstimateGlm: string;
  walletApprovalGlm: string;
  disclaimer: string;
}

export interface PreparedUploadResponse {
  text: string;
  embedding: number[];
  contentSha256: string;
  filename: string;
  mime: string;
  binary: boolean;
  title: string;
  kind: "upload";
  project: string;
  frontmatter: Record<string, unknown>;
  quote: UploadQuote;
}
