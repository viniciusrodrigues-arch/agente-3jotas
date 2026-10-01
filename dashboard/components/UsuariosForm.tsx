"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { IconCheck } from "@/components/ui/icons";
import { Toast, type ToastMensagem } from "@/components/ui/Toast";

export interface CorretorAcesso {
  id: string;
  nomeCrm: string;
  ativo: boolean;
  vinculado: boolean;
}

interface UsuarioPermissao {
  id: string;
  email: string;
  papel: "admin" | "gestor" | null;
  corretor: string | null;
}

function LinhaCorretor({
  corretor,
  onVinculado,
  onDesvinculado,
  onErro,
}: {
  corretor: CorretorAcesso;
  onVinculado: (id: string) => void;
  onDesvinculado: (id: string) => void;
  onErro: (texto: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    setSalvando(true);
    try {
      const resp = await fetch(`/api/corretores/${corretor.id}/vincular-login`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginEmail: email.trim() }),
      });
      const dados = await resp.json();
      if (!resp.ok || dados.ok === false) throw new Error(dados.erro ?? "Falha ao vincular login");

      if (email.trim()) onVinculado(corretor.id);
      else onDesvinculado(corretor.id);
      setEmail("");
    } catch (err) {
      onErro(err instanceof Error ? err.message : "Falha ao vincular login");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card variant="elevated" className="flex items-center justify-between gap-4 !rounded-md">
      <div className="min-w-0">
        <p className="font-semibold text-text-primary truncate">
          {corretor.nomeCrm} {!corretor.ativo && <span className="text-xs text-text-secondary font-normal">· inativo</span>}
        </p>
        <div className="mt-1">
          {corretor.vinculado ? <Badge variant="success">Vinculado</Badge> : <Badge variant="neutral">Sem acesso</Badge>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={corretor.vinculado ? "Novo email (ou vazio pra desvincular)" : "Email de login"}
          className="w-64"
        />
        <IconButton label="Salvar" onClick={salvar} disabled={salvando}>
          <IconCheck />
        </IconButton>
      </div>
    </Card>
  );
}

export function UsuariosForm({ corretoresIniciais }: { corretoresIniciais: CorretorAcesso[] }) {
  const [modo, setModo] = useState<"vincular" | "gestao">("vincular");
  const [corretores, setCorretores] = useState(corretoresIniciais);
  const [toast, setToast] = useState<ToastMensagem | null>(null);
  const [usuarios, setUsuarios] = useState<UsuarioPermissao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvandoUsuario, setSalvandoUsuario] = useState<string | null>(null);

  async function carregarUsuarios() {
    setCarregando(true);
    try {
      const resp = await fetch("/api/usuarios/permissoes", { cache: "no-store" });
      const dados = await resp.json();
      if (!resp.ok) throw new Error(dados.erro ?? "Falha ao carregar usuários");
      setUsuarios(dados.usuarios);
    } catch (err) {
      setToast({ tipo: "erro", texto: err instanceof Error ? err.message : "Falha ao carregar usuários" });
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => { void carregarUsuarios(); }, []);

  async function alterarPapel(userId: string, papel: UsuarioPermissao["papel"]) {
    setSalvandoUsuario(userId);
    try {
      const resp = await fetch("/api/usuarios/permissoes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, papel }),
      });
      const dados = await resp.json();
      if (!resp.ok) throw new Error(dados.erro ?? "Falha ao atualizar permissão");
      setUsuarios((prev) => prev.map((u) => u.id === userId ? { ...u, papel } : u));
      setToast({ tipo: "ok", texto: "Permissão atualizada." });
    } catch (err) {
      setToast({ tipo: "erro", texto: err instanceof Error ? err.message : "Falha ao atualizar permissão" });
    } finally {
      setSalvandoUsuario(null);
    }
  }

  function marcarVinculado(id: string) {
    setCorretores((prev) => prev.map((c) => (c.id === id ? { ...c, vinculado: true } : c)));
    setToast({ tipo: "ok", texto: "Login vinculado com sucesso." });
  }

  function marcarDesvinculado(id: string) {
    setCorretores((prev) => prev.map((c) => (c.id === id ? { ...c, vinculado: false } : c)));
    setToast({ tipo: "ok", texto: "Login desvinculado." });
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Tipo de gerenciamento de usuários" className="inline-flex rounded-lg bg-gray-100 p-1">
        {(["vincular", "gestao"] as const).map((opcao) => (
          <button
            key={opcao}
            type="button"
            role="tab"
            id={`usuarios-tab-${opcao}`}
            aria-selected={modo === opcao}
            aria-controls={`usuarios-painel-${opcao}`}
            onClick={() => setModo(opcao)}
            className={`rounded-md px-5 py-2 text-sm font-semibold transition-colors ${
              modo === opcao ? "bg-white text-navy-900 shadow-sm" : "text-text-secondary hover:text-navy-900"
            }`}
          >
            {opcao === "vincular" ? "Vincular" : "Gestão"}
          </button>
        ))}
      </div>

      {modo === "vincular" && <div id="usuarios-painel-vincular" role="tabpanel" aria-labelledby="usuarios-tab-vincular" className="space-y-4">
        <p className="text-sm text-text-secondary">
          Vincule cada corretor a um usuário já criado em Supabase Auth (Authentication &gt; Users) pelo email — o
          corretor passa a ver só as próprias análises e reativações ao logar.
        </p>

        <div className="space-y-3">
          {corretores.map((c) => (
            <LinhaCorretor
              key={c.id}
              corretor={c}
              onVinculado={(id) => { marcarVinculado(id); void carregarUsuarios(); }}
              onDesvinculado={(id) => { marcarDesvinculado(id); void carregarUsuarios(); }}
              onErro={(texto) => setToast({ tipo: "erro", texto })}
            />
          ))}
        </div>
      </div>}

      {modo === "gestao" && <div id="usuarios-painel-gestao" role="tabpanel" aria-labelledby="usuarios-tab-gestao" className="space-y-3">
        <div>
          <h2 className="font-semibold text-navy-900">Administradores e gestores</h2>
          <p className="text-sm text-text-secondary">Defina o acesso de cada conta do Supabase Auth. Gestores acompanham todos os corretores; apenas administradores alteram configurações e permissões. Sem acesso aguarda um vínculo ou uma permissão.</p>
        </div>
        {carregando && <p className="text-sm text-text-secondary">Carregando usuários...</p>}
        {!carregando && usuarios.map((usuario) => (
          <Card key={usuario.id} variant="elevated" className="flex items-center justify-between gap-4 !rounded-md">
            <div className="min-w-0">
              <p className="font-semibold text-text-primary truncate">{usuario.email}</p>
              {usuario.corretor && <p className="text-xs text-text-secondary">Corretor: {usuario.corretor}</p>}
            </div>
            {usuario.corretor ? <Badge variant="neutral">Corretor</Badge> : (
              <select
                aria-label={`Permissão de ${usuario.email}`}
                value={usuario.papel ?? ""}
                onChange={(event) => void alterarPapel(usuario.id, event.target.value === "" ? null : event.target.value as "admin" | "gestor")}
                disabled={salvandoUsuario === usuario.id}
                className="rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary"
              >
                <option value="">Sem acesso</option>
                <option value="gestor">Gestor</option>
                <option value="admin">Administrador</option>
              </select>
            )}
          </Card>
        ))}
      </div>}

      {toast && <Toast mensagem={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
