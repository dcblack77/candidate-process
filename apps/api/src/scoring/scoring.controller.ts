import {
    body,
    controller,
    Http,
    param,
    Patch,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canAnalyzeCandidate,
    canEditScores,
    requirePermission,
} from "../security/permissions";
import { AddNoteUseCase } from "./add-note.usecase";
import { AnalyzeCandidateUseCase } from "./analyze-candidate.usecase";
import { EditScoreUseCase } from "./edit-score.usecase";
import {
    AddNoteResponseDTO,
    AnalyzeResponseDTO,
    CandidateScoreDTO,
} from "./scoring.dto";

/**
 * Rutas de análisis y puntuación (BLUEPRINT §10):
 * POST /candidates/:id/analyze, PATCH /candidates/:id/score,
 * POST /candidates/:id/notes.
 *
 * Permisos (§09): analyze usa canAnalyzeCandidate; score y notes usan
 * canEditScores (las notas viven en candidate_score). Siempre en backend.
 */
@controller("/candidates")
export class ScoringController {
    constructor(
        @inject(AnalyzeCandidateUseCase)
        private readonly analyzeCandidate: AnalyzeCandidateUseCase,
        @inject(EditScoreUseCase) private readonly editScore: EditScoreUseCase,
        @inject(AddNoteUseCase) private readonly addNote: AddNoteUseCase,
    ) {}

    @Post("/:id/analyze")
    @Http(200)
    analyze(
        @request() req: Request,
        @param("id") id: string,
    ): Promise<AnalyzeResponseDTO> {
        requirePermission(canAnalyzeCandidate, req.currentUser);
        return this.analyzeCandidate.execute(id);
    }

    @Patch("/:id/score")
    @Http(200)
    score(
        @request() req: Request,
        @param("id") id: string,
        @body() payload: unknown,
    ): CandidateScoreDTO {
        requirePermission(canEditScores, req.currentUser);
        return this.editScore.execute(id, payload);
    }

    @Post("/:id/notes")
    @Http(200)
    notes(
        @request() req: Request,
        @param("id") id: string,
        @body() payload: unknown,
    ): AddNoteResponseDTO {
        requirePermission(canEditScores, req.currentUser);
        return this.addNote.execute(id, payload);
    }
}
