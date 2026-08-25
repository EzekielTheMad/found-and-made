import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { McpHttpHandler } from "@modelcontextprotocol/server";

import type { DatabaseHandle } from "./db/database.server";
import { openDatabase } from "./db/database.server";
import {
  ensureDataPaths,
  resolveDataPaths,
  type DataPaths,
} from "./files/data-paths.server";
import { ImportUploadStore } from "./files/import-upload.server";
import { JobQueue } from "./jobs/job-queue.server";
import { JobWorker, type JobHandler } from "./jobs/job-worker.server";
import { createPublicContentAcquirer } from "./network/public-content-acquirer.server";
import {
  ensureInstanceKey,
  readInstanceKey,
} from "./secrets/instance-key.server";
import { createAuthServer, type AuthServer } from "./auth/auth.server";
import { IdentityService } from "../modules/identity/identity.service.server";
import { systemPrincipal } from "../modules/identity/identity.types";
import { DiscoveryService } from "../modules/discovery/discovery.service.server";
import { CookingService } from "../modules/cooking/cooking.service.server";
import { BackupService } from "../modules/backup/backup.service.server";
import { ExportService } from "../modules/exports/export.service.server";
import {
  IMPORT_JOB_TYPE,
  ImportService,
} from "../modules/imports/import.service.server";
import { openAIImportProviderFromEnv } from "../modules/imports/openai-import-provider.server";
import { openAIImportMediaExtractorFromEnv } from "../modules/imports/openai-media-extractor.server";
import { PublishingService } from "../modules/publishing/publishing.service.server";
import { PrintingService } from "../modules/printing/printing.service.server";
import { PrintSelectionService } from "../modules/printing/print-selection.service.server";
import { RecipeService } from "../modules/recipes/recipe.service.server";
import { RecipeAccessService } from "../modules/recipes/recipe-access.service.server";
import { RecoveryService } from "../modules/recovery/recovery.service.server";
import { MediaService } from "../modules/media/media.service.server";
import { McpService } from "../modules/mcp/mcp.service.server";
import { SystemService } from "../modules/system/system.service.server";
import { SessionService } from "./auth/session.service.server";
import {
  createSmtpRecoveryMailer,
  type SmtpRecoveryMailer,
} from "./email/smtp-recovery.server";
import { PrintGenerationService } from "./printing/print-generation.server";
import { createFoundMadeMcpHandler } from "./mcp/found-made-mcp-handler.server";
import {
  mcpTransportConfigFromEnv,
  type McpTransportConfig,
} from "./mcp/mcp-transport-config.server";
import { McpRequestLimiter } from "./mcp/mcp-request-limiter.server";
import { publicUrl as configuredPublicUrl } from "./http/public-origin.server";

interface CreateRuntimeOptions {
  dataDir?: string;
  startWorker?: boolean;
}

export interface AppRuntime {
  auth: AuthServer;
  backupService: BackupService;
  close(): Promise<void>;
  cookingService: CookingService;
  dataPaths: DataPaths;
  database: DatabaseHandle;
  discoveryService: DiscoveryService;
  exportService: ExportService;
  identityService: IdentityService;
  importService: ImportService;
  importUploadStore: ImportUploadStore;
  jobQueue: JobQueue;
  jobWorker: JobWorker;
  mediaService: MediaService;
  mcpHttpHandler: McpHttpHandler;
  mcpRequestLimiter: McpRequestLimiter;
  mcpService: McpService;
  mcpTransportConfig: McpTransportConfig;
  printGenerationService: PrintGenerationService;
  printingService: PrintingService;
  printSelectionService: PrintSelectionService;
  publishingService: PublishingService;
  publicUrl(pathname: string): string;
  recipeAccessService: RecipeAccessService;
  recipeService: RecipeService;
  ready(): Promise<void>;
  recoveryService: RecoveryService;
  sessionService: SessionService;
  smtpRecoveryMailer?: SmtpRecoveryMailer;
  systemService: SystemService;
}

const runtimeSymbol = Symbol.for("found-and-made.runtime");
type RuntimeGlobal = typeof globalThis & {
  [runtimeSymbol]?: AppRuntime;
};

export async function createRuntime(
  options: CreateRuntimeOptions = {},
): Promise<AppRuntime> {
  const dataPaths = resolveDataPaths(options.dataDir ?? process.env.DATA_DIR);
  await ensureDataPaths(dataPaths);
  await ensureInstanceKey(dataPaths.keys);

  const database = openDatabase({
    filePath: join(dataPaths.db, "found-and-made.sqlite"),
  });
  const systemService = new SystemService(database);
  systemService.initialize();
  const recipeService = new RecipeService(database.sqlite);
  const recipeAccessService = new RecipeAccessService(recipeService);
  const discoveryService = new DiscoveryService(database.sqlite, recipeService);
  discoveryService.ensureStarterViews(systemPrincipal);
  const mediaService = new MediaService(
    database.sqlite,
    dataPaths,
    recipeService,
  );
  const exportService = new ExportService(
    recipeAccessService,
    mediaService,
    database.sqlite,
    dataPaths.exports,
  );
  const backupService = new BackupService(dataPaths, database.sqlite);
  const mcpService = new McpService(
    database.sqlite,
    recipeAccessService,
    discoveryService,
  );
  const mcpHttpHandler = createFoundMadeMcpHandler(mcpService);
  const mcpTransportConfig = mcpTransportConfigFromEnv();
  const mcpRequestLimiter = new McpRequestLimiter(
    mcpTransportConfig.requestRateLimit,
  );
  const cookingService = new CookingService(
    database.sqlite,
    recipeAccessService,
  );
  const printingService = new PrintingService(
    database.sqlite,
    recipeAccessService,
    dataPaths.print,
  );
  const printSelectionService = new PrintSelectionService(
    discoveryService,
    recipeAccessService,
  );
  const printGenerationService = new PrintGenerationService(
    printingService,
    recipeAccessService,
    mediaService,
  );
  const identityService = new IdentityService(database.sqlite);
  const recoveryService = new RecoveryService(database.sqlite);
  const publishingService = new PublishingService(
    database.sqlite,
    recipeService,
  );
  const auth = createAuthServer({
    database: database.db,
    secret: await readInstanceKey(dataPaths.keys),
  });
  const sessionService = new SessionService(auth, identityService);
  const smtpRecoveryMailer = createSmtpRecoveryMailer();

  const jobQueue = new JobQueue(database.sqlite);
  const importUploadStore = new ImportUploadStore(dataPaths);
  const modelProvider = openAIImportProviderFromEnv();
  const mediaTextExtractor = openAIImportMediaExtractorFromEnv();
  const importService = new ImportService({
    discoveryService,
    importUploads: importUploadStore,
    jobQueue,
    mediaService,
    ...(mediaTextExtractor ? { mediaTextExtractor } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    publicContentAcquirer: createPublicContentAcquirer(),
    recipeAccess: recipeAccessService,
    sqlite: database.sqlite,
  });
  importService.enqueuePendingFinalization();
  const handlers = new Map<string, JobHandler>([
    [IMPORT_JOB_TYPE, importService.jobHandler],
    ["system.noop", async () => Promise.resolve()],
  ]);
  const jobWorker = new JobWorker({ handlers, queue: jobQueue });

  const runtime: AppRuntime = {
    auth,
    backupService,
    cookingService,
    dataPaths,
    database,
    discoveryService,
    exportService,
    identityService,
    importService,
    importUploadStore,
    jobQueue,
    jobWorker,
    mediaService,
    mcpHttpHandler,
    mcpRequestLimiter,
    mcpService,
    mcpTransportConfig,
    printGenerationService,
    printingService,
    printSelectionService,
    publishingService,
    publicUrl: configuredPublicUrl,
    recipeAccessService,
    recipeService,
    recoveryService,
    sessionService,
    ...(smtpRecoveryMailer ? { smtpRecoveryMailer } : {}),
    systemService,
    async close() {
      await jobWorker.stop();
      await mcpHttpHandler.close();
      smtpRecoveryMailer?.close();
      database.close();
    },
    async ready() {
      const result = database.sqlite.prepare("SELECT 1 AS ok").get() as
        { ok: number } | undefined;
      if (result?.ok !== 1) throw new Error("Database readiness query failed");

      for (const directory of [
        dataPaths.db,
        dataPaths.keys,
        dataPaths.mediaOriginals,
      ]) {
        await access(directory, constants.R_OK | constants.W_OK);
      }
    },
  };

  if (options.startWorker !== false) jobWorker.start();
  await runtime.ready();
  return runtime;
}

export async function initializeApplicationRuntime(): Promise<AppRuntime> {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  if (!runtimeGlobal[runtimeSymbol]) {
    runtimeGlobal[runtimeSymbol] = await createRuntime();
  }
  return runtimeGlobal[runtimeSymbol];
}

export function getApplicationRuntime(): AppRuntime {
  const runtime = (globalThis as RuntimeGlobal)[runtimeSymbol];
  if (!runtime) throw new Error("Application runtime is not initialized");
  return runtime;
}

export async function shutdownApplicationRuntime(): Promise<void> {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  const runtime = runtimeGlobal[runtimeSymbol];
  if (!runtime) return;
  delete runtimeGlobal[runtimeSymbol];
  await runtime.close();
}
