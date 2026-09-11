// TEMPORÁRIO — remover após execução do seed (BeeUp Teste demo data)
import {
  Controller, Post, Headers, ForbiddenException, Inject,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Controller('admin/seed-beeup')
export class SeedBeeupController {
  constructor(@Inject(DATABASE_CLIENT) private readonly sql: any) {}

  @Post()
  async run(@Headers('x-seed-key') key: string) {
    if (!key || key !== process.env.ENCRYPTION_KEY) {
      throw new ForbiddenException('Chave inválida');
    }

    const now = new Date();
    function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
    function daysFromNow(n: number) { const d = new Date(); d.setDate(d.getDate() + n); return d; }
    function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
    function pick<T>(arr: T[]): T { return arr[rand(0, arr.length - 1)]; }

    // ── Localizar loja ──────────────────────────────────────────────────
    const [loja] = await this.sql`
      SELECT id, nome FROM lojas
      WHERE (nome ILIKE '%beeup%' OR nome ILIKE '%bee up%') AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!loja) return { erro: 'Loja BeeUp não encontrada' };
    const lojaId: string = loja.id;

    // ── Etapas ─────────────────────────────────────────────────────────
    const etapas: any[] = await this.sql`
      SELECT id, nome, tipo, ordem FROM etapas_jornada
      WHERE loja_id = ${lojaId} AND ativo = true ORDER BY ordem
    `;
    const etapaAguardando = etapas.find(e => e.tipo === 'intermediaria' && e.ordem === 1);
    const etapaOrcamento  = etapas.find(e => e.tipo === 'intermediaria' && e.ordem === 2);
    const etapaComprou    = etapas.find(e => e.tipo === 'final_comprou');
    const etapaNaoComprou = etapas.find(e => e.tipo === 'final_nao_comprou');

    function mapEtapa(tipo: string, ordem: number) {
      if (tipo === 'final_comprou')     return { etapa: etapaComprou,    sj: 'comprou' };
      if (tipo === 'final_nao_comprou') return { etapa: etapaNaoComprou, sj: 'nao_comprou' };
      if (ordem === 2)                  return { etapa: etapaOrcamento,  sj: 'orcamento_enviado' };
      return { etapa: etapaAguardando, sj: 'aguardando' };
    }

    // ── Produtos ────────────────────────────────────────────────────────
    const PRODUTOS = [
      { nome: 'Ração Golden Adult Frango e Arroz 15kg', descricao: 'Ração seca completa para cães adultos raças médias e grandes. Formula balanceada com vitaminas e minerais.', preco: 189.90, especificacao: '15kg', estoque: 45 },
      { nome: 'Ração Premier Gatos Adultos Salmão 1kg', descricao: 'Ração premium para gatos adultos. Rica em proteína de salmão e ômega-3.', preco: 35.90, especificacao: '1kg', estoque: 30 },
      { nome: 'Areia Sanitária Pipicat Classic 4kg', descricao: 'Areia sanitária aglomerante com ação antibacteriana e perfume suave.', preco: 22.50, especificacao: '4kg', estoque: 60 },
      { nome: 'Vermífugo Caniztel Plus 4 comprimidos', descricao: 'Vermífugo oral de amplo espectro para cães. Elimina vermes intestinais.', preco: 28.00, especificacao: '4 comprimidos', estoque: 25 },
      { nome: 'Antipulgas Frontline Spray 250ml', descricao: 'Antipulgas e carrapatos para cães de 10 a 20kg. Proteção de até 30 dias.', preco: 52.00, especificacao: '250ml', estoque: 15 },
      { nome: 'Dentastix Raça Média 7 unidades', descricao: 'Snack dental que reduz tártaro e placa bacteriana. Sabor original.', preco: 18.90, especificacao: '7 unidades', estoque: 40 },
      { nome: 'Shampoo Sanol Dog Neutro 500ml', descricao: 'Shampoo hipoalergênico neutro para cães e gatos de pele sensível.', preco: 16.50, especificacao: '500ml', estoque: 35 },
      { nome: 'Petisco Whiskas Temptations Mix 40g', descricao: 'Petisco cremoso para gatos adultos. Irresistível por dentro, crocante por fora.', preco: 8.90, especificacao: '40g', estoque: 80 },
    ];

    const prods: any[] = [];
    for (const p of PRODUTOS) {
      const [ex] = await this.sql`SELECT id, nome, preco FROM produtos WHERE loja_id = ${lojaId} AND nome = ${p.nome} AND deleted_at IS NULL`;
      if (ex) { prods.push(ex); continue; }
      const [np] = await this.sql`
        INSERT INTO produtos (loja_id, nome, descricao, preco, especificacao, estoque)
        VALUES (${lojaId}, ${p.nome}, ${p.descricao}, ${p.preco}, ${p.especificacao}, ${p.estoque})
        RETURNING id, nome, preco
      `;
      prods.push(np);
    }

    // ── Clientes ────────────────────────────────────────────────────────
    const NOMES = [
      'Ana Silva','Maria Santos','José Oliveira','João Souza','Paulo Lima','Pedro Costa',
      'Carla Ferreira','Fernanda Alves','Marcos Rodrigues','Lucas Pereira','Juliana Nascimento',
      'Patrícia Carvalho','Carlos Gomes','Ricardo Martins','Sandra Ribeiro','Claudia Dias',
      'Rafael Fernandes','Rodrigo Monteiro','Vanessa Barbosa','Aline Araújo','Bruno Cardoso',
      'Camila Correia','Diego Campos','Elaine Azevedo','Fabricio Moreira','Gabriela Nunes',
      'Henrique Andrade','Isabela Teixeira','Jaqueline Borges','Karina Cunha',
      'Leonardo Moraes','Mariana Vieira','Natalia Castro','Otavio Ramos','Priscila Lopes',
      'Renata Soares','Sergio Freitas','Tatiana Rocha','Ulisses Pinto','Viviane Cruz',
      'Wellington Almeida','Amanda Cavalcante','Beatriz Miranda','Cristiane Pacheco',
      'Daniela Fonseca','Eduardo Santana','Flavia Duarte','Guilherme Xavier','Helena Mello',
      'Igor Tavares','Joana Machado','Katia Nobre','Larissa Peixoto','Marcelo Queiroz',
      'Nathalia Rezende','Oscar Valente','Pamela Guimarães','Roberto Abreu',
      'Simone Viana','Tiago Siqueira','Ursula Leite','Valeria Figueiredo','Wander Chaves',
      'Yasmin Caldeira','Zelma Magalhães','Alexandre Braga','Bruna Matos','Celso Diniz',
      'Debora Carmo','Emerson Henrique','Fatima Conceição','Gerson Amorim','Heloisa Medeiros',
      'Ivone Coelho','Jorge Baptista','Keila Novais','Luisa Esteves','Marta Batista',
      'Nilson Coutinho','Otilia Macedo',
    ];
    const ORIGENS = ['instagram','instagram','instagram','indicacao','indicacao','google','google','site',null,null];
    const HORARIOS = ['08:00','09:00','09:30','10:00','10:30','14:00','15:00','16:00','19:00'];
    const INTERVALOS = [7,15,15,30,30,30,30,45,60];
    const VALORES = [32,42,52,63,78,89,99,115,125,138,155,169,189,210,225,245];

    const clientes: any[] = [];
    let novosClientes = 0;

    for (let i = 0; i < NOMES.length; i++) {
      const telefone = `+5511990${String(i + 1).padStart(5, '0')}`;
      const [ex] = await this.sql`
        SELECT id FROM clientes WHERE loja_id = ${lojaId} AND telefone = ${telefone} AND deleted_at IS NULL
      `;
      if (ex) { clientes.push({ id: ex.id }); continue; }

      const origem = pick(ORIGENS);
      const r = Math.random();
      const diaAtras = r < 0.55 ? rand(0, 30) : r < 0.85 ? rand(31, 60) : rand(61, 90);
      const createdAt = daysAgo(diaAtras);

      const [cl] = await this.sql`
        INSERT INTO clientes
          (loja_id, nome, telefone, ativo, consentimento_whatsapp, consentimento_data,
           origem_lead, created_at, updated_at)
        VALUES
          (${lojaId}, ${NOMES[i]}, ${telefone}, true, true, ${createdAt},
           ${origem}, ${createdAt}, ${createdAt})
        RETURNING id
      `;
      clientes.push({ id: cl.id });
      novosClientes++;
    }

    // ── Ciclos ──────────────────────────────────────────────────────────
    const ciclos: any[] = [];
    for (let i = 0; i < Math.min(68, clientes.length); i++) {
      const cliente = clientes[i];
      const produto = pick(prods);
      const intervalo = pick(INTERVALOS);
      const horario = pick(HORARIOS);
      const adiado = Math.random() < 0.12;
      const precisaRevisao = adiado && Math.random() < 0.5;

      const r = Math.random();
      let proxima: Date;
      if (r < 0.35) {
        proxima = daysAgo(rand(1, 28));
      } else if (r < 0.45) {
        proxima = new Date();
        const [h, m] = horario.split(':');
        proxima.setHours(parseInt(h), parseInt(m), 0, 0);
      } else {
        proxima = daysFromNow(rand(1, 60));
      }

      const ultimaCompraDate = daysAgo(rand(intervalo, intervalo * 3)).toISOString().slice(0, 10);

      const [ciclo] = await this.sql`
        INSERT INTO ciclos_recompra
          (loja_id, cliente_id, produto_id, intervalo_dias, quantidade, ativo,
           proxima_notificacao, ultima_compra, horario_envio,
           adiado_pelo_cliente, precisa_revisao)
        VALUES
          (${lojaId}, ${cliente.id}, ${produto.id}, ${intervalo}, ${rand(1, 3)}, true,
           ${proxima}, ${ultimaCompraDate}, ${horario}, ${adiado}, ${precisaRevisao})
        RETURNING id
      `;

      await this.sql`
        INSERT INTO ciclo_produtos (ciclo_id, produto_id)
        VALUES (${ciclo.id}, ${produto.id})
        ON CONFLICT DO NOTHING
      `;

      // Segundo produto (25% dos clientes)
      if (Math.random() < 0.25) {
        const p2 = pick(prods.filter(p => p.id !== produto.id));
        if (p2) {
          await this.sql`INSERT INTO ciclo_produtos (ciclo_id, produto_id) VALUES (${ciclo.id}, ${p2.id}) ON CONFLICT DO NOTHING`.catch(() => {});
        }
      }

      ciclos.push({ id: ciclo.id, clienteId: cliente.id, produtoId: produto.id, adiado });
    }

    // ── Lembretes ───────────────────────────────────────────────────────
    const STATUSES = ['enviado','enviado','enviado','enviado','sem_resposta','sem_resposta','respondido'];
    const lembretesInseridos: any[] = [];

    for (const ciclo of ciclos) {
      const count = rand(1, 3);
      for (let l = 0; l < count; l++) {
        const diaAtras = rand(2, 88);
        const agendadoPara = daysAgo(diaAtras);
        const status = pick(STATUSES);
        const enviadoEm = status !== 'agendado' ? agendadoPara : null;

        const [lem] = await this.sql`
          INSERT INTO lembretes
            (loja_id, ciclo_id, status, agendado_para, enviado_em, tentativa, created_at, updated_at)
          VALUES
            (${lojaId}, ${ciclo.id}, ${status}, ${agendadoPara}, ${enviadoEm}, 1, ${agendadoPara}, ${agendadoPara})
          RETURNING id
        `;
        lembretesInseridos.push({
          id: lem.id, clienteId: ciclo.clienteId, produtoId: ciclo.produtoId,
          status, agendadoPara,
        });
      }
    }

    // ── Pedidos ─────────────────────────────────────────────────────────
    let pedidosCount = 0;
    const respondidos = lembretesInseridos.filter(l => l.status === 'respondido');

    for (const lem of respondidos) {
      const r = Math.random();
      let tipo: string; let ordem: number;
      if (r < 0.50)      { tipo = 'final_comprou';      ordem = 3; }
      else if (r < 0.70) { tipo = 'intermediaria';      ordem = 1; }
      else if (r < 0.88) { tipo = 'intermediaria';      ordem = 2; }
      else               { tipo = 'final_nao_comprou';  ordem = 4; }

      const { etapa, sj } = mapEtapa(tipo, ordem);
      if (!etapa) continue;

      const valor = tipo === 'final_comprou' ? pick(VALORES) : null;
      const confirmadoEm = tipo === 'final_comprou' ? lem.agendadoPara : null;

      await this.sql`
        INSERT INTO pedidos
          (loja_id, lembrete_id, cliente_id, produto_id, quantidade,
           status, status_jornada, etapa_id, valor, confirmado_em, created_at, updated_at)
        VALUES
          (${lojaId}, ${lem.id}, ${lem.clienteId}, ${lem.produtoId}, 1,
           'confirmado', ${sj}, ${etapa.id}, ${valor}, ${confirmadoEm},
           ${lem.agendadoPara}, ${lem.agendadoPara})
      `.catch(() => {});
      pedidosCount++;
    }

    // Pedidos extras com distribuição controlada por período
    const extras = [
      // Últimos 7 dias
      ...Array.from({ length: 5 }, () => ({ da: rand(0, 7),   tipo: 'final_comprou',     ordem: 3 })),
      ...Array.from({ length: 3 }, () => ({ da: rand(0, 7),   tipo: 'intermediaria',     ordem: 1 })),
      ...Array.from({ length: 2 }, () => ({ da: rand(0, 7),   tipo: 'intermediaria',     ordem: 2 })),
      ...Array.from({ length: 2 }, () => ({ da: rand(0, 7),   tipo: 'final_nao_comprou', ordem: 4 })),
      // Dias 8-30
      ...Array.from({ length: 13 }, () => ({ da: rand(8, 30),  tipo: 'final_comprou',    ordem: 3 })),
      ...Array.from({ length: 5 },  () => ({ da: rand(8, 30),  tipo: 'intermediaria',    ordem: 1 })),
      ...Array.from({ length: 3 },  () => ({ da: rand(8, 30),  tipo: 'intermediaria',    ordem: 2 })),
      ...Array.from({ length: 2 },  () => ({ da: rand(8, 30),  tipo: 'final_nao_comprou',ordem: 4 })),
      // Dias 31-90
      ...Array.from({ length: 14 }, () => ({ da: rand(31, 88), tipo: 'final_comprou',    ordem: 3 })),
      ...Array.from({ length: 4 },  () => ({ da: rand(31, 88), tipo: 'intermediaria',    ordem: 1 })),
      ...Array.from({ length: 3 },  () => ({ da: rand(31, 88), tipo: 'final_nao_comprou',ordem: 4 })),
    ];

    const shuffled = [...clientes].sort(() => Math.random() - 0.5);
    for (let i = 0; i < extras.length; i++) {
      const spec = extras[i];
      const cliente = shuffled[i % shuffled.length];
      const produto = pick(prods);
      const createdAt = daysAgo(spec.da);
      const { etapa, sj } = mapEtapa(spec.tipo, spec.ordem);
      if (!etapa) continue;

      const valor = spec.tipo === 'final_comprou' ? pick(VALORES) : null;
      const confirmadoEm = spec.tipo === 'final_comprou' ? createdAt : null;

      await this.sql`
        INSERT INTO pedidos
          (loja_id, cliente_id, produto_id, quantidade,
           status, status_jornada, etapa_id, valor, confirmado_em, created_at, updated_at)
        VALUES
          (${lojaId}, ${cliente.id}, ${produto.id}, 1,
           'confirmado', ${sj}, ${etapa.id}, ${valor}, ${confirmadoEm}, ${createdAt}, ${createdAt})
      `.catch(() => {});
      pedidosCount++;
    }

    // ── Resumo final ────────────────────────────────────────────────────
    const [cSt]   = await this.sql`SELECT COUNT(*)::int AS n FROM clientes WHERE loja_id = ${lojaId} AND deleted_at IS NULL AND ativo = true`;
    const [pSt]   = await this.sql`SELECT COUNT(*)::int AS n FROM produtos WHERE loja_id = ${lojaId} AND deleted_at IS NULL AND ativo = true`;
    const [ciSt]  = await this.sql`SELECT COUNT(*)::int AS n FROM ciclos_recompra WHERE loja_id = ${lojaId} AND deleted_at IS NULL AND ativo = true`;
    const [lSt]   = await this.sql`SELECT COUNT(*)::int AS n FROM lembretes WHERE loja_id = ${lojaId}`;
    const [pedSt] = await this.sql`SELECT COUNT(*)::int AS n FROM pedidos WHERE loja_id = ${lojaId} AND deleted_at IS NULL`;
    const [adiSt] = await this.sql`SELECT COUNT(*)::int AS n FROM ciclos_recompra WHERE loja_id = ${lojaId} AND deleted_at IS NULL AND adiado_pelo_cliente = true`;
    const [vencSt] = await this.sql`SELECT COUNT(*)::int AS n FROM ciclos_recompra WHERE loja_id = ${lojaId} AND deleted_at IS NULL AND ativo = true AND proxima_notificacao < NOW()`;

    const etapaStats = await this.sql`
      SELECT ej.nome, COUNT(p.id)::int AS n
      FROM etapas_jornada ej
      LEFT JOIN pedidos p ON p.etapa_id = ej.id AND p.loja_id = ${lojaId} AND p.deleted_at IS NULL
      WHERE ej.loja_id = ${lojaId} AND ej.ativo = true
      GROUP BY ej.id, ej.nome, ej.ordem ORDER BY ej.ordem
    `;

    const dashboard: any[] = [];
    for (const dias of [7, 15, 30, 90]) {
      const [d] = await this.sql`
        SELECT COUNT(*)::int AS vendas, COALESCE(SUM(valor), 0) AS receita
        FROM pedidos WHERE loja_id = ${lojaId} AND deleted_at IS NULL
          AND status_jornada = 'comprou'
          AND confirmado_em >= NOW() - (${dias} || ' days')::INTERVAL
      `;
      dashboard.push({ dias, vendas: d.vendas, receita: parseFloat(d.receita) });
    }

    const origens = await this.sql`
      SELECT COALESCE(origem_lead, 'sem_origem') AS origem, COUNT(*)::int AS n
      FROM clientes WHERE loja_id = ${lojaId} AND deleted_at IS NULL
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY origem_lead ORDER BY n DESC
    `;

    return {
      loja: loja.nome,
      inseridos: { novosClientes, ciclos: ciclos.length, lembretesInseridos: lembretesInseridos.length, pedidos: pedidosCount },
      totaisAtuais: {
        clientes: cSt.n, produtos: pSt.n, ciclos: ciSt.n,
        ciclosVencidos: vencSt.n, ciclosAdiados: adiSt.n,
        lembretes: lSt.n, pedidos: pedSt.n,
      },
      pedidosPorEtapa: etapaStats.map((e: any) => ({ etapa: e.nome, total: e.n })),
      dashboard,
      novosPorOrigem30dias: origens,
    };
  }
}
