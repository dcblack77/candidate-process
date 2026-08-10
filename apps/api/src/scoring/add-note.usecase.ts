import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { ScoreRepository } from "./score.repository";
import { AddNoteResponseDTO, parseNotesInput } from "./scoring.dto";

/**
 * POST /candidates/:id/notes — notas privadas del evaluador.
 *
 * DECISIÓN documentada: REEMPLAZA manual_notes (el plan dice "actualiza",
 * no "añade"); enviar "" las vacía. Si el candidato aún no tiene fila de
 * score se crea una con solo manual_notes (los criterios admiten NULL).
 * Auditado SIN contenido: solo la longitud.
 */
@injectable()
export class AddNoteUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ScoreRepository) private readonly scores: ScoreRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(id: unknown, body: unknown): AddNoteResponseDTO {
        assertValidId(id);
        const { notes } = parseNotesInput(body);

        const selected = requireWritableProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, selected.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }

        if (this.scores.findByCandidate(id)) {
            this.scores.updateManual(id, { manualNotes: notes });
        } else {
            this.scores.createManual(id, { manualNotes: notes });
        }

        this.audit.logEvent("candidate.note_saved", "candidate", id, {
            length: notes.length,
        });

        return { candidateId: id, notesSaved: true };
    }
}
