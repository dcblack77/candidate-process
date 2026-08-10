import { useState } from "react";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    COVERAGE_CLASSES,
    COVERAGE_LABELS,
    ProposalDTO,
} from "../api/types";
import { ErrorAlert } from "../components/ui";

/**
 * Propuesta del análisis de audio dentro del bloque de una pregunta (§24).
 *
 * Nada se aplica solo. Aplicar dispara el PATCH de la respuesta DE SIEMPRE y
 * después marca la propuesta; el sistema propone y el evaluador decide.
 *
 * Las citas se muestran SIEMPRE, con su minuto: son lo que permite comprobar
 * en la grabación que el candidato dijo eso de verdad antes de darlo por bueno.
 */

/** Por debajo de esto la tarjeta nace plegada, con aviso. */
const LOW_CONFIDENCE = 0.5;

/** `754` → `12:34`, para localizar la cita en la grabación. */
function timestamp(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
        total % 60,
    ).padStart(2, "0")}`;
}

export function ProposalCard({
    candidateId,
    proposal,
    onApply,
    onResolved,
}: {
    candidateId: string;
    proposal: ProposalDTO;
    /** Escribe la respuesta real. Se llama ANTES de marcar la propuesta. */
    onApply: (score: number, notes: string | null) => Promise<void>;
    onResolved: () => Promise<void>;
}) {
    const lowConfidence =
        proposal.confidence !== null && proposal.confidence < LOW_CONFIDENCE;
    const [open, setOpen] = useState(!lowConfidence);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canApply = proposal.proposedScore !== null;

    async function resolve(status: "applied" | "dismissed") {
        setBusy(true);
        setError(null);
        try {
            if (status === "applied") {
                if (proposal.proposedScore === null) {
                    return;
                }
                // Primero la escritura de verdad; la propuesta solo se marca
                // si la nota llegó a guardarse.
                await onApply(proposal.proposedScore, proposal.proposedNotes);
            }
            await api.resolveProposal(candidateId, proposal.id, status);
            await onResolved();
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="proposal-card">
            <div className="proposal-head">
                <span
                    className={`badge ${COVERAGE_CLASSES[proposal.coverage]}`}
                >
                    {COVERAGE_LABELS[proposal.coverage]}
                </span>
                {proposal.proposedScore !== null && (
                    <strong>Nota propuesta: {proposal.proposedScore}/10</strong>
                )}
                {!open && (
                    <button
                        className="link-button"
                        onClick={() => setOpen(true)}
                    >
                        Ver propuesta
                    </button>
                )}
            </div>

            {lowConfidence && (
                <p className="muted small">
                    El sistema no está seguro de esta propuesta. Revisa las
                    citas antes de aplicarla.
                </p>
            )}

            {open && (
                <>
                    {proposal.proposedNotes && (
                        <p className="small">{proposal.proposedNotes}</p>
                    )}

                    {proposal.evidence.length > 0 ? (
                        <ul className="proposal-quotes">
                            {proposal.evidence.map((item, i) => (
                                <li key={i}>
                                    <span className="muted small">
                                        [{timestamp(item.startSec)}]
                                    </span>{" "}
                                    <q>{item.quote}</q>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="muted small">
                            Sin citas verificadas del candidato.
                        </p>
                    )}

                    <ErrorAlert message={error} />
                    <div className="actions-row">
                        {canApply && (
                            <button
                                className="primary"
                                onClick={() => void resolve("applied")}
                                disabled={busy}
                            >
                                {busy ? "Aplicando…" : "Usar esta propuesta"}
                            </button>
                        )}
                        <button
                            onClick={() => void resolve("dismissed")}
                            disabled={busy}
                        >
                            Descartar
                        </button>
                    </div>
                    <p className="muted small">
                        Propuesta del sistema a partir de la transcripción.
                        Revísala antes de aplicarla.
                    </p>
                </>
            )}
        </div>
    );
}
