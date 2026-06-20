// Nome das filas BullMQ — centralizado aqui para não ter string mágica espalhada no código
// Qualquer arquivo que precisar referenciar uma fila importa daqui.

export const FILA_LEMBRETES    = 'lembretes';   // Fila principal: envio de lembretes
export const FILA_RETRY        = 'retry';       // Fila de retentativas
export const FILA_RELATORIO    = 'relatorio';   // Fila do relatório periódico (RF-42)

// Nomes dos jobs dentro de cada fila
export const JOB_ENVIAR_LEMBRETE     = 'enviar-lembrete';
export const JOB_VERIFICAR_RESPOSTA  = 'verificar-resposta';  // Checa se cliente respondeu
export const JOB_RETRY_LEMBRETE      = 'retry-lembrete';
export const JOB_ENVIAR_RELATORIO    = 'enviar-relatorio';
