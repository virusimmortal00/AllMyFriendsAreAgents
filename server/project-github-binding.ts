import type { GitHubIntegrationStore, ProjectGitHubBinding } from "./github-integration-store.js";
import type { RepairProjectRepositoryInput, RepositoryRepairStatus } from "../shared/project-repository-repair.js";
import {
  publicRepositoryConnectionStatus,
  verifyRepositoryCheckout,
  type ConnectRepositoryInput,
  type ProjectRepositoryConnectionService,
  type PublicRepositoryConnectionStatus,
  type RepositoryConnectionResult,
} from "./project-repository-connection.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface ConfigureProjectGitHubRepositoryInput {
  readonly projectId: string;
  readonly githubConnectionId: string;
  readonly githubRepositoryId: number;
  readonly expectedBindingRevision: number;
  readonly expectedRepositoryRevision: number;
  readonly checkoutPath: string;
  readonly worktreeRoot: string;
  readonly protectedBranches?: readonly string[];
  readonly policyRevision: number;
  readonly validationCommands?: readonly string[];
  readonly sensitivePaths?: readonly string[];
}

export interface PublicProjectGitHubBinding {
  readonly projectId: string;
  readonly revision: number;
  readonly state: "ready" | "revoked";
  readonly connectionId: string;
  readonly installationId: number;
  readonly githubRepositoryId: number;
  readonly repository: string;
  readonly updatedAt: string;
}

export interface PublicProjectGitHubRepositoryStatus {
  readonly binding?: PublicProjectGitHubBinding;
  readonly repository: PublicRepositoryConnectionStatus;
}

export type ConfigureProjectGitHubRepositoryResult =
  | { readonly kind: "ok"; readonly value: PublicProjectGitHubRepositoryStatus }
  | { readonly kind: "conflict"; readonly scope: "binding" | "repository"; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

type RepositoryAuthority = Pick<ProjectRepositoryConnectionService, "inspect" | "inspectServer" | "connect" | "repair" | "inspectRepair">;

/** Joins catalog selection and local checkout authority without accepting a secret or opaque binding reference from a client. */
export class ProjectGitHubBindingService {
  constructor(
    private readonly integrations: GitHubIntegrationStore,
    private readonly repositoryForProject: (projectId: string) => RepositoryAuthority,
  ) {}

  inspect(projectId: string): PublicProjectGitHubRepositoryStatus | undefined {
    if (!SAFE_ID.test(projectId)) return undefined;
    const repository = this.repositoryForProject(projectId).inspect();
    const binding = this.integrations.bindingForProject(projectId);
    if (!binding && !repository.configured) return { repository };
    return { ...(binding ? { binding: publicBinding(binding) } : {}), repository };
  }

  async inspectRepair(projectId: string): Promise<RepositoryRepairStatus> {
    const authority = this.repositoryForProject(projectId);
    const status = await authority.inspectRepair();
    const binding = this.integrations.bindingForProject(projectId);
    const repository = authority.inspectServer();
    if (!binding || binding.state !== "ready" || binding.bindingId !== repository?.credentialReference
      || binding.repository !== repository.remote.canonical || repository.projectId !== projectId) {
      return { ...status, state: "unavailable", reason: "matching-ready-binding-required" };
    }
    return status;
  }

  async repair(input: RepairProjectRepositoryInput & { readonly projectId: string }): Promise<ConfigureProjectGitHubRepositoryResult> {
    if (!SAFE_ID.test(input.projectId) || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 1) {
      return { kind: "rejected", reason: "Project repository repair input is not canonical." };
    }
    const binding = this.integrations.bindingForProject(input.projectId);
    if ((binding?.revision ?? 0) !== input.expectedBindingRevision) return { kind: "conflict", scope: "binding", actualRevision: binding?.revision ?? 0 };
    const authority = this.repositoryForProject(input.projectId);
    const validateBinding = () => {
      const latest = this.integrations.bindingForProject(input.projectId);
      const repository = authority.inspectServer();
      if (!binding || !latest || latest.revision !== binding.revision || latest.state !== "ready"
        || latest.bindingId !== binding.bindingId || latest.bindingId !== repository?.credentialReference
        || latest.repository !== repository.remote.canonical || repository.projectId !== input.projectId) {
        throw new Error("Repository repair requires an unchanged, matching ready GitHub binding.");
      }
    };
    const result = await authority.repair({ expectedRevision: input.expectedRepositoryRevision,
      idempotencyKey: input.idempotencyKey, checkoutPath: input.checkoutPath, worktreeRoot: input.worktreeRoot }, validateBinding);
    if (result.kind !== "ok") return repositoryFailure(result);
    return { kind: "ok", value: { binding: publicBinding(binding!), repository: publicRepositoryConnectionStatus(result.connection) } };
  }

  async configure(input: ConfigureProjectGitHubRepositoryInput): Promise<ConfigureProjectGitHubRepositoryResult> {
    if (!canonicalInput(input)) return { kind: "rejected", reason: "Project repository configuration is not canonical." };
    const connection = this.integrations.connection(input.githubConnectionId);
    if (!connection || connection.state !== "ready") return { kind: "rejected", reason: "A ready server GitHub connection is required." };
    const catalog = this.integrations.catalog(connection.connectionId);
    if (!catalog || catalog.connectionRevision !== connection.revision) return { kind: "rejected", reason: "A current repository catalog is required." };
    const selected = catalog.repositories.find((repository) => repository.githubRepositoryId === input.githubRepositoryId);
    if (!selected) return { kind: "rejected", reason: "Selected repository is not present in the current server catalog." };

    const currentBinding = this.integrations.bindingForProject(input.projectId);
    if ((currentBinding?.revision ?? 0) !== input.expectedBindingRevision) {
      return { kind: "conflict", scope: "binding", actualRevision: currentBinding?.revision ?? 0 };
    }
    const authority = this.repositoryForProject(input.projectId);
    const currentRepository = authority.inspectServer();
    if ((currentRepository?.revision ?? 0) !== input.expectedRepositoryRevision) {
      return { kind: "conflict", scope: "repository", actualRevision: currentRepository?.revision ?? 0 };
    }
    if (currentRepository && currentRepository.state !== "disabled") {
      return { kind: "rejected", reason: "The project already has an enabled repository connection." };
    }

    const verification = await verifyRepositoryCheckout({ checkoutPath: input.checkoutPath, worktreeRoot: input.worktreeRoot,
      defaultBranch: selected.defaultBranch, expectedRepository: selected.canonical });
    if (verification.kind !== "ok") return verification;

    const binding = await this.integrations.bindProject({ expectedRevision: input.expectedBindingRevision, projectId: input.projectId,
      connectionId: connection.connectionId, installationId: selected.installationId, githubRepositoryId: selected.githubRepositoryId,
      repository: selected.canonical });
    if (binding.kind === "conflict") return { ...binding, scope: "binding" };
    if (binding.kind === "rejected") return binding;

    const repositoryInput: ConnectRepositoryInput = {
      expectedRevision: input.expectedRepositoryRevision,
      checkoutPath: input.checkoutPath,
      worktreeRoot: input.worktreeRoot,
      defaultBranch: selected.defaultBranch,
      protectedBranches: input.protectedBranches,
      policyRevision: input.policyRevision,
      validationCommands: input.validationCommands,
      sensitivePaths: input.sensitivePaths,
      credentialReference: binding.value.bindingId,
    };
    const repository = await authority.connect(repositoryInput);
    if (repository.kind !== "ok") {
      const rollback = await this.integrations.revokeBinding({ projectId: input.projectId, expectedRevision: binding.value.revision });
      if (rollback.kind !== "ok") {
        return { kind: "rejected", reason: "Repository connection failed and the GitHub binding rollback did not complete. Reconfigure the project." };
      }
      return repositoryFailure(repository);
    }
    return { kind: "ok", value: { binding: publicBinding(binding.value), repository: publicRepositoryConnectionStatus(repository.connection) } };
  }
}

function publicBinding(binding: ProjectGitHubBinding): PublicProjectGitHubBinding {
  return { projectId: binding.projectId, revision: binding.revision, state: binding.state, connectionId: binding.connectionId,
    installationId: binding.installationId, githubRepositoryId: binding.githubRepositoryId, repository: binding.repository, updatedAt: binding.updatedAt };
}

function repositoryFailure(result: Exclude<RepositoryConnectionResult, { readonly kind: "ok" }>): ConfigureProjectGitHubRepositoryResult {
  return result.kind === "conflict"
    ? { kind: "conflict", scope: "repository", actualRevision: result.actualRevision }
    : result;
}

function canonicalInput(input: ConfigureProjectGitHubRepositoryInput) {
  return SAFE_ID.test(input.projectId) && SAFE_ID.test(input.githubConnectionId)
    && Number.isSafeInteger(input.githubRepositoryId) && input.githubRepositoryId > 0
    && Number.isSafeInteger(input.expectedBindingRevision) && input.expectedBindingRevision >= 0
    && Number.isSafeInteger(input.expectedRepositoryRevision) && input.expectedRepositoryRevision >= 0
    && Number.isSafeInteger(input.policyRevision) && input.policyRevision > 0;
}
