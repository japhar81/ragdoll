export {
  OpenSearchClient,
  OpenSearchError,
  createOpenSearchClient,
  awsSigV4FromSecrets,
  awsSigV4FromConnectionOptions,
  mergeAwsSigV4,
  AWS_SIGV4_SECRET_FIELDS
} from "./client.ts";
export type {
  BulkDoc,
  FetchLike,
  OpenSearchAuth,
  OpenSearchClientConfig,
  SearchHit,
  AwsSigV4Config
} from "./client.ts";
export {
  signSigV4,
  createAwsCredentialsProvider
} from "./aws-sigv4.ts";
export type {
  AwsCredentials,
  AwsCredentialsProvider
} from "./aws-sigv4.ts";
export { OpenSearchVectorStore } from "./vector-store.ts";
