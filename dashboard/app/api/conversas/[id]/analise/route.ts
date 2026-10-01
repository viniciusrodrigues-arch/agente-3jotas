import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getDashboardSession } from "@/lib/session";

// Botão "Desconsiderar análise" — exclui a análise de vez (não é só um
// status "desconsiderada"): a nota some do banco, corretor_ranking e as
// médias por critério recalculam sozinhos na próxima leitura (são agregados
// ao vivo via SQL, não um valor guardado em algum lugar). Se a conversa
// receber mensagem nova depois, o sync-clint recria a análise normalmente
// (fluxo de sempre) e ela volta a ser processada do zero.
//
// Uma conversa pode ter várias linhas de análise (uma por dia de atividade,
// ver migration 0040/0042) — sem `?dia=`, apaga só a linha do dia mais
// recente (preserva o histórico de dias anteriores, mais seguro que apagar
// tudo de uma vez). Com `?dia=YYYY-MM-DD`, apaga só aquela linha específica
// (uso do botão de desconsiderar dentro do histórico de dias).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getDashboardSession();
  if (session?.role !== "admin" && session?.role !== "gestor") {
    return NextResponse.json({ ok: false, erro: "Apenas administradores e gestores podem desconsiderar análises." }, { status: 403 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  const diaParam = new URL(req.url).searchParams.get("dia");

  let dia = diaParam;
  if (!dia) {
    const { data: maisRecente, error: buscaError } = await supabase
      .from("analises")
      .select("dia")
      .eq("conversa_id", id)
      .order("dia", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (buscaError) {
      return NextResponse.json({ ok: false, erro: buscaError.message }, { status: 500 });
    }
    if (!maisRecente) {
      return NextResponse.json({ ok: true });
    }
    dia = maisRecente.dia;
  }

  const { error } = await supabase.from("analises").delete().eq("conversa_id", id).eq("dia", dia);

  if (error) {
    return NextResponse.json({ ok: false, erro: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
