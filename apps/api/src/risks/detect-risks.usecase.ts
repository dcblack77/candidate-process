import { inject, injectable } from "@expressots/core";
import { LlmClient } from "../ai/llm-client";
import { NEUTRAL_ROLE_CONTEXT } from "../ai/role-context";
import {
    DETECT_RISKS_JSON_SCHEMA,
    DetectRisksResult,
    detectRisksZodSchema,
} from "../ai/schemas/detect-risks";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    MAX_RISK_DETECTIONS_PER_CANDIDATE,
    RATE_LIMITS_PER_HOUR,
} from "../shared/limits";
import { RiskRepository } from "./risk.repository";
import { verifyRisks } from "./risk-verifier";
import {
    DetectRisksResponseDTO,
    toRiskAnalysisDTO,
    toRiskItems,
} from "./risks.dto";

/** Nombre del prompt (prompts/detect-risks-and-gaps.md). */
const RISKS_PROMPT = "detect-risks-and-gaps";

/** Clave del rate limiter para la detección de riesgos (§16: 30/hora). */
export const RISKS_RATE_KEY = "risks";

/** Acción de auditoría cuyo conteo por candidato limita las regeneraciones. */
export const RISKS_DETECTED_ACTION = "candidate.risks_detected";

/**
 * POST /candidates/:id/risks (BLUEPRINT §13 "Riesgos y lagunas").
 *
 * Señala, para un candidato, qué NO se puede saber a partir de su CV
 * (lagunas) y dónde están los riesgos de contratarlo (riesgos), cada uno con
 * qué preguntar en la entrevista para despejarlo. Es material para la
 * entrevista, no una conclusión: no toca puntuaciones ni ranking.
 *
 * - Requiere solo el `cv_summary` (como generar preguntas): no exige análisis
 *   previo, que gastaría una de las 5 regeneraciones (§16) sin necesidad.
 *   Sin `cv_summary` → 400 INVALID_INPUT (mismo criterio que analyze).
 * - Límite §16: 5 detecciones por candidato, contadas como eventos
 *   'candidate.risks_detected' de ese entity_id. La 6ª → 422 LIMIT_EXCEEDED.
 * - La salida del modelo pasa por risks/risk-verifier.ts ANTES de persistirse:
 *   una evidencia `explicit` que el resumen no sostiene se rebaja a
 *   `inferred`. Un riesgo inventado es peor que no reportarlo.
 * - Una fila por candidato: regenerar sobrescribe la anterior.
 * - Fallo del modelo → el error viaja al handler central (502) y no se
 *   persiste ni se cuenta nada.
 */
@injectable()
export class DetectRisksUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(RiskRepository) private readonly risks: RiskRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(LlmClient) private readonly llm: LlmClient,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    async execute(id: unknown): Promise<DetectRisksResponseDTO> {
        assertValidId(id);
        const selected = requireWritableProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, selected.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }
        if (!candidate.cv_summary) {
            throw new AppError(
                "INVALID_INPUT",
                "Este candidato aún no tiene el CV procesado: súbelo antes de detectar riesgos.",
            );
        }

        const regenerationsUsed = this.audit.countByActionAndEntity(
            RISKS_DETECTED_ACTION,
            id,
        );
        if (regenerationsUsed >= MAX_RISK_DETECTIONS_PER_CANDIDATE) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Se alcanzó el máximo de detecciones de riesgos para este candidato.",
            );
        }

        this.rateLimiter.check(RISKS_RATE_KEY, RATE_LIMITS_PER_HOUR.RISKS);

        const roleContext = selected.role_context ?? NEUTRAL_ROLE_CONTEXT;
        const startedAt = Date.now();
        const raw = await this.llm.complete<DetectRisksResult>({
            promptName: RISKS_PROMPT,
            variables: {
                cv_summary_json: candidate.cv_summary,
                role_title: selected.role_title,
                role_context: roleContext,
            },
            schema: DETECT_RISKS_JSON_SCHEMA,
            zodSchema: detectRisksZodSchema,
        });

        // Verificación en código, no en el prompt: solo lo que el modelo tuvo
        // delante (resumen + rol) puede ser evidencia explícita.
        const { result, stats } = verifyRisks(raw, [
            candidate.cv_summary,
            selected.role_context ?? "",
        ]);
        const items = toRiskItems(result);

        const row = this.risks.upsert(id, {
            confidence: result.confidence,
            risksJson: JSON.stringify(items.risks),
            gapsJson: JSON.stringify(items.gaps),
            statsJson: JSON.stringify(stats),
        });

        // Auditoría sin contenido (§17): conteos, confianza y duración. El
        // propio evento cuenta la regeneración.
        this.audit.logEvent(RISKS_DETECTED_ACTION, "candidate", id, {
            regeneration: regenerationsUsed + 1,
            confidence: result.confidence,
            risks: stats.risks,
            gaps: stats.gaps,
            downgradedToInferred: stats.downgradedToInferred,
            durationMs: Date.now() - startedAt,
        });

        return {
            candidateId: id,
            analysis: toRiskAnalysisDTO(row),
            regenerationsUsed: regenerationsUsed + 1,
            regenerationsLimit: MAX_RISK_DETECTIONS_PER_CANDIDATE,
        };
    }
}
