import { buscarDashboardOverview } from "@/lib/dashboard-data";
import { CRITERIO_LABEL } from "@/lib/types";
import { StatCard } from "@/components/StatCard";
import { Card } from "@/components/ui/Card";
import { ScoreBadge } from "@/components/ScoreBadge";
import { TendenciaChart } from "@/components/TendenciaChart";
import { PontosAtencaoCard } from "@/components/PontosAtencaoCard";
import { CorretoresComErrosCard } from "@/components/CorretoresComErrosCard";

export default async function DashboardPage() {
  const d = await buscarDashboardOverview();

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-extrabold text-navy-900">Dashboard</h1>
        <p className="text-sm text-text-secondary">Visão geral dos atendimentos</p>
      </div>


      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Chats analisados"
          value={d.chatsAnalisadosHoje}
          trend={{ value: d.variacaoChatsAnalisadosPercentual, label: "vs. ontem" }}
        />
        <StatCard label="Pendentes de análise (serão analisados hoje)" value={d.conversasPendentesAnalise} hint="Na fila de processamento" />
        <StatCard label="Média geral" value={d.mediaGeralQuinzena.toFixed(1)} hint="Quinzena atual · escala 0-10" />
        <StatCard label="Pontos de atenção" value={d.pontosAtencao.length} hint="Detectados nas últimas 24h" />
      </div>

      <Card>
        <p className="text-sm font-semibold text-navy-900 mb-4">Média por critério (hoje)</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {Object.entries(d.distribuicaoPorCriterio).map(([criterio, valor]) => (
            <div key={criterio} className="flex flex-col gap-1.5">
              <p className="text-xs text-text-secondary">{CRITERIO_LABEL[criterio as keyof typeof CRITERIO_LABEL]}</p>
              <ScoreBadge score={valor} />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <p className="text-sm font-semibold text-navy-900 mb-4">Clientes e média de score por dia</p>
        <TendenciaChart dados={d.tendenciaDiaria} />
      </Card>

      <div className="grid lg:grid-cols-2 gap-6 items-stretch">
        <PontosAtencaoCard pontosAtencao={d.pontosAtencao} />
        <CorretoresComErrosCard corretoresComMaisErros={d.corretoresComMaisErros} />
      </div>
    </div>
  );
}
