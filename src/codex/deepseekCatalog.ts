// DeepSeek Codex catalog metadata, reviewed 2026-10-25. Source: https://api-docs.deepseek.com/quick_start/agent_integrations/codex/
// Uses the corresponding Apache-2.0 Codex template, not a custom PlanSwap prompt. See THIRD_PARTY_NOTICES.md.
// No setup script is executed. Runtime compatibility remains pending.
import { CODEX_BASE_INSTRUCTIONS } from './codexBaseInstructions';
export const DEEPSEEK_CATALOG = {
  "models": [
    {
      "slug": "deepseek-flash",
      "prefer_websockets": false,
      "support_verbosity": true,
      "default_verbosity": "low",
      "apply_patch_tool_type": "freeform",
      "web_search_tool_type": "text",
      "input_modalities": [
        "text",
        "image"
      ],
      "supports_image_detail_original": true,
      "truncation_policy": {
        "mode": "tokens",
        "limit": 10000
      },
      "supports_parallel_tool_calls": true,
      "tool_mode": null,
      "multi_agent_version": "v2",
      "use_responses_lite": false,
      "include_skills_usage_instructions": false,
      "auto_review_model_override": null,
      "context_window": 1048576,
      "max_context_window": 1048576,
      "effective_context_window_percent": 95,
      "auto_compact_token_limit": null,
      "comp_hash": "3000",
      "reasoning_summary_format": "experimental",
      "default_reasoning_summary": "none",
      "display_name": "DeepSeek-Flash",
      "description": "DeepSeek model through the Responses API.",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        {
          "effort": "low",
          "description": "low"
        },
        {
          "effort": "high",
          "description": "high"
        },
        {
          "effort": "max",
          "description": "max"
        }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "minimal_client_version": "0.144.0",
      "supported_in_api": true,
      "availability_nux": null,
      "upgrade": null,
      "priority": 1,
      "experimental_supported_tools": [],
      "supports_search_tool": true,
      "default_service_tier": null,
      "supports_reasoning_summaries": true,
      "base_instructions": CODEX_BASE_INSTRUCTIONS
    },
    {
      "slug": "deepseek-v4-pro",
      "prefer_websockets": false,
      "support_verbosity": true,
      "default_verbosity": "low",
      "apply_patch_tool_type": "freeform",
      "web_search_tool_type": "text",
      "input_modalities": [
        "text"
      ],
      "supports_image_detail_original": false,
      "truncation_policy": {
        "mode": "tokens",
        "limit": 10000
      },
      "supports_parallel_tool_calls": true,
      "tool_mode": null,
      "multi_agent_version": "v2",
      "use_responses_lite": false,
      "include_skills_usage_instructions": false,
      "auto_review_model_override": null,
      "context_window": 1048576,
      "max_context_window": 1048576,
      "effective_context_window_percent": 95,
      "auto_compact_token_limit": null,
      "comp_hash": "3000",
      "reasoning_summary_format": "experimental",
      "default_reasoning_summary": "none",
      "display_name": "DeepSeek-V4-Pro",
      "description": "DeepSeek model through the Responses API.",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        {
          "effort": "low",
          "description": "low"
        },
        {
          "effort": "high",
          "description": "high"
        },
        {
          "effort": "max",
          "description": "max"
        }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "minimal_client_version": "0.144.0",
      "supported_in_api": true,
      "availability_nux": null,
      "upgrade": null,
      "priority": 2,
      "experimental_supported_tools": [],
      "supports_search_tool": false,
      "default_service_tier": null,
      "supports_reasoning_summaries": true,
      "base_instructions": CODEX_BASE_INSTRUCTIONS
    }
  ]
} as const;
