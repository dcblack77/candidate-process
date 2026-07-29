import { EvidenceItem } from "../api/types";

/**
 * Lista de evidencias con distinción VISUAL clara (§13):
 * - explicit → sólida (fondo verde, borde continuo, texto normal).
 * - inferred → atenuada (gris, cursiva, borde discontinuo) + etiqueta.
 */
export function EvidenceList({ items }: { items: EvidenceItem[] }) {
    if (items.length === 0) {
        return <p className="muted small">Sin evidencias registradas.</p>;
    }
    return (
        <ul className="evidence-list">
            {items.map((item, index) => (
                <li
                    key={index}
                    className={`evidence-item evidence-${item.type}`}
                    data-evidence-type={item.type}
                >
                    <span className="evidence-tag">
                        {item.type === "explicit" ? "Explícita" : "Inferida"}
                    </span>
                    <span>{item.text}</span>
                </li>
            ))}
        </ul>
    );
}
