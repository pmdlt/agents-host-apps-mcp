# Tool list

Every tool the generator emits from the curation table and the API's OpenAPI document (`src/agent/tools/generated.ts`). A remote MCP client sees only the ones its token's scope and the person's current role allow (`src/mcp/server.ts`, `visibleTools`).

94 tools: 84 offered, 10 hidden. Seven hand-written tools sit beside them on `/mcp` (`pilae_read_logs`, `pilae_read_deploy_log`, `pilae_env_keys`, `pilae_compose_services`, the workflow guide, run logs and run results); they are not in this list.

| Tool | Route | Minimum role | Kind |
|---|---|---|---|
| `pilae_services_list` | GET `/v1/services` | member | read |
| `pilae_services_get` | GET `/v1/services/{kind}/{id}` | member | read |
| `pilae_services_deployments` | GET `/v1/services/{kind}/{id}/deployments` | member | read |
| `pilae_services_domains_list` | GET `/v1/services/{kind}/{id}/domains` | member | read |
| `pilae_services_public_access` | GET `/v1/services/{kind}/{id}/public-access` | member | read |
| `pilae_services_ports_list` | GET `/v1/services/{kind}/{id}/ports` | member | read |
| `pilae_services_mounts_list` | GET `/v1/services/{kind}/{id}/mounts` | member | read |
| `pilae_services_create` | POST `/v1/services/{kind}` | admin | write |
| `pilae_services_update` | PATCH `/v1/services/{kind}/{id}` | admin | write |
| `pilae_services_deploy` | POST `/v1/services/{kind}/{id}/deploy` | admin | write |
| `pilae_services_redeploy` | POST `/v1/services/{kind}/{id}/redeploy` | admin | write |
| `pilae_services_start` | POST `/v1/services/{kind}/{id}/start` | admin | write |
| `pilae_services_stop` | POST `/v1/services/{kind}/{id}/stop` | admin | destructive |
| `pilae_services_env_update` | PATCH `/v1/services/{kind}/{id}/env` | admin | destructive |
| `pilae_services_domain_add` | POST `/v1/services/{kind}/{id}/domains` | admin | write |
| `pilae_services_domain_update` | PATCH `/v1/services/{kind}/{id}/domains/{domainId}` | admin | write |
| `pilae_services_public_access_set` | PUT `/v1/services/{kind}/{id}/public-access` | admin | write |
| `pilae_services_port_add` | POST `/v1/services/{kind}/{id}/ports` | admin | write |
| `pilae_services_mount_add` | POST `/v1/services/{kind}/{id}/mounts` | admin | write |
| `pilae_services_delete` | DELETE `/v1/services/{kind}/{id}` | owner | destructive |
| `pilae_services_domain_remove` | DELETE `/v1/services/{kind}/{id}/domains/{domainId}` | admin | destructive |
| `pilae_services_port_remove` | DELETE `/v1/services/{kind}/{id}/ports/{portId}` | admin | destructive |
| `pilae_services_mount_remove` | DELETE `/v1/services/{kind}/{id}/mounts/{mountId}` | admin | destructive |
| `pilae_projects_list` | GET `/v1/projects` | member | read |
| `pilae_projects_get` | GET `/v1/projects/{id}` | member | read |
| `pilae_projects_create` | POST `/v1/projects` | admin | write |
| `pilae_projects_update` | PATCH `/v1/projects/{id}` | admin | write |
| `pilae_projects_delete` | DELETE `/v1/projects/{id}` | owner | destructive |
| `pilae_backups_list` | GET `/v1/services/{kind}/{id}/backups` | member | read |
| `pilae_backups_runs` | GET `/v1/backups/{backupId}/runs` | member | read |
| `pilae_restores_list` | GET `/v1/restores` | member | read |
| `pilae_backup_files` | GET `/v1/services/{kind}/{id}/backups/{backupId}/files` | member | read |
| `pilae_backups_create` | POST `/v1/services/{kind}/{id}/backups` | owner | write |
| `pilae_backups_run` | POST `/v1/services/{kind}/{id}/backups/{backupId}/run` | admin | write |
| `pilae_volume_backups_create` | POST `/v1/services/{kind}/{id}/volume-backups` | owner | write |
| `pilae_volume_backups_run` | POST `/v1/services/{kind}/{id}/volume-backups/{volumeBackupId}/run` | admin | write |
| `pilae_backups_delete` | DELETE `/v1/services/{kind}/{id}/backups/{backupId}` | owner | destructive |
| `pilae_volume_backups_delete` | DELETE `/v1/services/{kind}/{id}/volume-backups/{volumeBackupId}` | owner | destructive |
| `pilae_destinations_list` | GET `/v1/destinations` | member | read |
| `pilae_destinations_create` | POST `/v1/destinations` | owner | write |
| `pilae_destinations_update` | PATCH `/v1/destinations/{id}` | owner | write |
| `pilae_destinations_delete` | DELETE `/v1/destinations/{id}` | owner | destructive |
| `pilae_machines_list` | GET `/v1/machines` | member | read |
| `pilae_machines_get` | GET `/v1/machines/{id}` | member | read |
| `pilae_machines_metrics` | GET `/v1/machines/{id}/metrics` | member | read |
| `pilae_services_metrics` | GET `/v1/services/{kind}/{id}/metrics` | member | read |
| `pilae_deployments_list` | GET `/v1/deployments` | member | read |
| `pilae_activity_list` | GET `/v1/activity` | member | read |
| `pilae_alerts_list` | GET `/v1/alerts` | member | read |
| `pilae_alerts_settings` | GET `/v1/alerts/settings` | member | read |
| `pilae_recipes_list` | GET `/v1/recipes` | member | read |
| `pilae_provisioning_capabilities` | GET `/v1/provisioning/capabilities` | member | read |
| `pilae_provisioning_preflight` | GET `/v1/provisioning/preflight` | member | read |
| `pilae_provisioning_runs` | GET `/v1/provisioning/runs` | member | read |
| `pilae_provisioning_status` | GET `/v1/provisioning/runs/{id}` | member | read |
| `pilae_provision_app` | POST `/v1/provisioning/runs` | member | write |
| `pilae_provisioning_cancel` | POST `/v1/provisioning/runs/{id}/cancel` | member | destructive |
| `pilae_deploy_requests_list` | GET `/v1/deploy-requests` | member | read |
| `pilae_deploy_request_create` | POST `/v1/deploy-requests` | member | write |
| `pilae_deploy_request_update` | PATCH `/v1/deploy-requests/{id}` | member | write |
| `pilae_deploy_request_withdraw` | DELETE `/v1/deploy-requests/{id}` | member | destructive |
| `pilae_workflows_capabilities` | GET `/v1/workflows/capabilities` | member | read |
| `pilae_workflows_list` | GET `/v1/workflows` | member | read |
| `pilae_workflows_get` | GET `/v1/workflows/{slug}` | member | read |
| `pilae_workflows_versions` | GET `/v1/workflows/{slug}/versions` | member | read |
| `pilae_workflows_version_get` | GET `/v1/workflows/{slug}/versions/{version}` | member | read |
| `pilae_workflows_schedules_list` | GET `/v1/workflows/{slug}/schedules` | member | read |
| `pilae_workflows_runs_list` | GET `/v1/workflow-runs` | member | read |
| `pilae_workflows_run_get` | GET `/v1/workflow-runs/{id}` | member | read |
| `pilae_workflows_secrets_list` | GET `/v1/workflow-secrets` | member | read |
| `pilae_workflows_hooks_list` | GET `/v1/workflow-hooks` | member | read |
| `pilae_workflows_hook_hosts_list` | GET `/v1/workflow-hooks/hosts` | member | read |
| `pilae_workflows_create` | POST `/v1/workflows` | admin | write |
| `pilae_workflows_update` | PUT `/v1/workflows/{slug}` | admin | write |
| `pilae_workflows_test_run` | POST `/v1/workflows/test-run` | admin | write |
| `pilae_workflows_run` | POST `/v1/workflows/{slug}/runs` | admin | write |
| `pilae_workflows_hook_create` | POST `/v1/workflow-hooks` | admin | write |
| `pilae_workflows_hook_update` | PATCH `/v1/workflow-hooks/{hook}` | admin | write |
| `pilae_workflows_schedule_create` | POST `/v1/workflows/{slug}/schedules` | admin | write |
| `pilae_workflows_schedule_update` | PATCH `/v1/workflows/{slug}/schedules/{scheduleId}` | admin | write |
| `pilae_workflows_delete` | DELETE `/v1/workflows/{slug}` | owner | destructive |
| `pilae_workflows_hook_delete` | DELETE `/v1/workflow-hooks/{hook}` | admin | destructive |
| `pilae_workflows_schedule_delete` | DELETE `/v1/workflows/{slug}/schedules/{scheduleId}` | admin | destructive |
| `pilae_workflows_run_cancel` | POST `/v1/workflow-runs/{id}/cancel` | member | destructive |

Hidden (generated but never offered to a model; the raw log, build-log, env and compose routes are replaced by hand-written tools that redact or return names only, see `curation.ts`): `pilae_services_logs_raw`, `pilae_services_deployment_log_raw`, `pilae_services_env_raw`, `pilae_services_compose_file_raw`, `pilae_services_env_replace`, `pilae_activity_facets`, `pilae_documents_list`, `pilae_workflows_run_logs_raw`, `pilae_workflows_step_logs_raw`, `pilae_workflows_run_result_raw`.
