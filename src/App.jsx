import { useState, useEffect, useMemo } from "react";
import { db } from "./firebase";
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  writeBatch,
  orderBy,
  query,
} from "firebase/firestore";

// ---------- constantes ----------
const ORIGENS = ["Troco", "Caixa do dia"];
const CAIXAS_PADRAO = ["Saborey - Balcão", "Saborey - Delivery", "Holy"];

// ---------- helpers ----------
const fmtMoney = (v) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v) || 0);

const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const hojeLocalISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dia}`;
};

const dataComHoraAtual = (dataStr) => {
  const agora = new Date();
  const [y, m, d] = dataStr.split("-").map(Number);
  return new Date(
    y,
    m - 1,
    d,
    agora.getHours(),
    agora.getMinutes(),
    agora.getSeconds(),
    agora.getMilliseconds()
  ).toISOString();
};

const trocarDataMantendoHora = (isoOriginal, novaData) => {
  const original = isoOriginal ? new Date(isoOriginal) : new Date();
  const [y, m, d] = novaData.split("-").map(Number);
  return new Date(
    y,
    m - 1,
    d,
    original.getHours(),
    original.getMinutes(),
    original.getSeconds(),
    original.getMilliseconds()
  ).toISOString();
};

const dataLocalDeISO = (iso) => {
  if (!iso) return hojeLocalISO();
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dia}`;
};

async function hashSenha(senha) {
  try {
    const enc = new TextEncoder().encode(senha);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch (e) {
    let h = 0;
    for (let i = 0; i < senha.length; i++) h = (h * 31 + senha.charCodeAt(i)) >>> 0;
    return "f" + h.toString(16);
  }
}

// ---------- stamp ----------
function Stamp({ label = "RECEBIDO" }) {
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        right: "18px",
        transform: "translateY(-50%) rotate(-11deg)",
        border: "3px solid #8a1f1f",
        color: "#8a1f1f",
        fontFamily: "'Courier New', monospace",
        fontWeight: 800,
        letterSpacing: "2px",
        padding: "4px 10px",
        borderRadius: "6px",
        fontSize: "13px",
        opacity: 0.85,
        pointerEvents: "none",
        background: "rgba(255,255,255,0.04)",
        boxShadow: "0 0 0 1px rgba(138,31,31,0.15) inset",
      }}
    >
      {label}
    </div>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [usuarios, setUsuarios] = useState([]);
  const [registros, setRegistros] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [novoNome, setNovoNome] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [loginAlvo, setLoginAlvo] = useState(null);
  const [loginSenha, setLoginSenha] = useState("");
  const [erro, setErro] = useState("");
  const [erroLogin, setErroLogin] = useState("");

  const [novoNomeUser, setNovoNomeUser] = useState("");
  const [novaSenhaUser, setNovaSenhaUser] = useState("");
  const [novoUserAdmin, setNovoUserAdmin] = useState(false);
  const [erroNovoUsuario, setErroNovoUsuario] = useState("");
  const [okNovoUsuario, setOkNovoUsuario] = useState("");
  const [tab, setTab] = useState("pendentes");

  const [mostrarAlterarSenha, setMostrarAlterarSenha] = useState(false);
  const [senhaAtual, setSenhaAtual] = useState("");
  const [senhaNova, setSenhaNova] = useState("");
  const [senhaNovaConfirma, setSenhaNovaConfirma] = useState("");
  const [erroSenha, setErroSenha] = useState("");
  const [okSenha, setOkSenha] = useState("");

  const [caixaNome, setCaixaNome] = useState(CAIXAS_PADRAO[0]);
  const [caixaCustom, setCaixaCustom] = useState("");
  const [valor, setValor] = useState("");
  const [origem, setOrigem] = useState(ORIGENS[0]);
  const [dataLancamento, setDataLancamento] = useState(hojeLocalISO());

  const [editandoId, setEditandoId] = useState(null);
  const [editCaixa, setEditCaixa] = useState("");
  const [editValor, setEditValor] = useState("");
  const [editOrigem, setEditOrigem] = useState(ORIGENS[0]);
  const [editData, setEditData] = useState("");
  const [erroEdicao, setErroEdicao] = useState("");
  const [excluirConfirmId, setExcluirConfirmId] = useState(null);

  const [confirmandoRecebimentoId, setConfirmandoRecebimentoId] = useState(null);
  const [valorRecebido, setValorRecebido] = useState("");
  const [obsRecebimento, setObsRecebimento] = useState("");
  const [fotoRecebimento, setFotoRecebimento] = useState(null);
  const [enviandoFoto, setEnviandoFoto] = useState(false);
  const [erroRecebimento, setErroRecebimento] = useState("");

  const [filtroCaixa, setFiltroCaixa] = useState("Todos");
  const [filtroOrigem, setFiltroOrigem] = useState("Todos");

  const [conferencias, setConferencias] = useState([]);
  const [datasSelecionadas, setDatasSelecionadas] = useState([]);
  const [confirmandoConferencia, setConfirmandoConferencia] = useState(false);

  // ---------- sincronização em tempo real com o Firestore ----------
  useEffect(() => {
    const unsubUsuarios = onSnapshot(collection(db, "usuarios"), (snap) => {
      setUsuarios(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    const unsubRegistros = onSnapshot(
      query(collection(db, "registros"), orderBy("registradoEm", "desc")),
      (snap) => setRegistros(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    const unsubConferencias = onSnapshot(
      query(collection(db, "conferencias"), orderBy("conferidoEm", "desc")),
      (snap) => setConferencias(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return () => {
      unsubUsuarios();
      unsubRegistros();
      unsubConferencias();
    };
  }, []);

  // se o usuário logado for atualizado (ex: alterou senha/admin em outra aba), mantém sincronizado
  useEffect(() => {
    if (!currentUser) return;
    const atualizado = usuarios.find((u) => u.id === currentUser.id);
    if (atualizado && JSON.stringify(atualizado) !== JSON.stringify(currentUser)) {
      setCurrentUser(atualizado);
    }
  }, [usuarios]);

  const pendentes = useMemo(
    () => registros.filter((r) => r.status === "pendente"),
    [registros]
  );
  const recebidos = useMemo(
    () =>
      registros
        .filter((r) => r.status === "recebido")
        .sort((a, b) => (b.recebidoEm || "").localeCompare(a.recebidoEm || "")),
    [registros]
  );

  const totalPendente = pendentes.reduce((s, r) => s + Number(r.valor || 0), 0);

  const nomesCaixaExistentes = useMemo(() => {
    const set = new Set(CAIXAS_PADRAO);
    registros.forEach((r) => set.add(r.caixa));
    return Array.from(set);
  }, [registros]);

  const registrosFiltrados = useMemo(() => {
    return registros.filter(
      (r) =>
        (filtroCaixa === "Todos" || r.caixa === filtroCaixa) &&
        (filtroOrigem === "Todos" || r.origem === filtroOrigem)
    );
  }, [registros, filtroCaixa, filtroOrigem]);

  const porCaixa = useMemo(() => {
    const map = {};
    registrosFiltrados.forEach((r) => {
      if (!map[r.caixa]) map[r.caixa] = { total: 0, recebido: 0, pendente: 0, qtd: 0 };
      map[r.caixa].total += Number(r.valor);
      map[r.caixa].qtd += 1;
      if (r.status === "recebido") map[r.caixa].recebido += Number(r.valor);
      else map[r.caixa].pendente += Number(r.valor);
    });
    return map;
  }, [registrosFiltrados]);

  const porOrigem = useMemo(() => {
    const map = {};
    registrosFiltrados.forEach((r) => {
      if (!map[r.origem]) map[r.origem] = { total: 0, recebido: 0, pendente: 0, qtd: 0 };
      map[r.origem].total += Number(r.valor);
      map[r.origem].qtd += 1;
      if (r.status === "recebido") map[r.origem].recebido += Number(r.valor);
      else map[r.origem].pendente += Number(r.valor);
    });
    return map;
  }, [registrosFiltrados]);

  const totalFiltrado = registrosFiltrados.reduce((s, r) => s + Number(r.valor), 0);

  const diaKey = (iso) => (iso || "").slice(0, 10);
  const diaLabel = (key) => {
    const [y, m, d] = key.split("-");
    return `${d}/${m}/${y}`;
  };

  const diasDisponiveis = useMemo(() => {
    const map = {};
    recebidos.forEach((r) => {
      const key = diaKey(r.recebidoEm);
      if (!map[key]) map[key] = { total: 0, qtd: 0 };
      map[key].total += Number(r.valor);
      map[key].qtd += 1;
    });
    return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]));
  }, [recebidos]);

  const recebidosAgrupados = useMemo(() => {
    const map = {};
    recebidos.forEach((r) => {
      const key = diaKey(r.registradoEm);
      if (!map[key]) map[key] = [];
      map[key].push(r);
    });
    return Object.entries(map)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, itens]) => [
        key,
        itens.slice().sort((a, b) => (b.registradoEm || "").localeCompare(a.registradoEm || "")),
      ]);
  }, [recebidos]);

  const registrosSelecionados = useMemo(
    () => recebidos.filter((r) => datasSelecionadas.includes(diaKey(r.recebidoEm))),
    [recebidos, datasSelecionadas]
  );

  const resumoSelecao = useMemo(() => {
    const porCaixaSel = {};
    const porOrigemSel = {};
    let total = 0;
    registrosSelecionados.forEach((r) => {
      total += Number(r.valor);
      porCaixaSel[r.caixa] = (porCaixaSel[r.caixa] || 0) + Number(r.valor);
      porOrigemSel[r.origem] = (porOrigemSel[r.origem] || 0) + Number(r.valor);
    });
    return { total, porCaixaSel, porOrigemSel };
  }, [registrosSelecionados]);

  function toggleData(key) {
    setDatasSelecionadas((prev) =>
      prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key]
    );
  }

  // ---------- ações (Firestore) ----------
  async function cadastrarUsuario(e) {
    e.preventDefault();
    const nome = novoNome.trim();
    if (!nome || !novaSenha) {
      setErro("Preencha nome e senha.");
      return;
    }
    if (usuarios.some((u) => u.nome.toLowerCase() === nome.toLowerCase())) {
      setErro("Já existe um usuário com esse nome.");
      return;
    }
    const senhaHash = await hashSenha(novaSenha);
    const novo = { nome, senhaHash, admin: usuarios.length === 0 };
    const ref = await addDoc(collection(db, "usuarios"), novo);
    setNovoNome("");
    setNovaSenha("");
    setErro("");
    setCurrentUser({ id: ref.id, ...novo });
  }

  async function criarUsuario(e) {
    e.preventDefault();
    setOkNovoUsuario("");
    const nome = novoNomeUser.trim();
    if (!nome || !novaSenhaUser) {
      setErroNovoUsuario("Preencha nome e senha.");
      return;
    }
    if (usuarios.some((u) => u.nome.toLowerCase() === nome.toLowerCase())) {
      setErroNovoUsuario("Já existe um usuário com esse nome.");
      return;
    }
    const senhaHash = await hashSenha(novaSenhaUser);
    await addDoc(collection(db, "usuarios"), { nome, senhaHash, admin: novoUserAdmin });
    setNovoNomeUser("");
    setNovaSenhaUser("");
    setNovoUserAdmin(false);
    setErroNovoUsuario("");
    setOkNovoUsuario(`Usuário "${nome}" cadastrado.`);
  }

  async function confirmarLogin(e) {
    e.preventDefault();
    const senhaHash = await hashSenha(loginSenha);
    if (senhaHash !== loginAlvo.senhaHash) {
      setErroLogin("Senha incorreta.");
      return;
    }
    setCurrentUser(loginAlvo);
    setLoginAlvo(null);
    setLoginSenha("");
    setErroLogin("");
  }

  async function alterarSenha(e) {
    e.preventDefault();
    setErroSenha("");
    setOkSenha("");
    const hashAtual = await hashSenha(senhaAtual);
    if (hashAtual !== currentUser.senhaHash) {
      setErroSenha("Senha atual incorreta.");
      return;
    }
    if (!senhaNova || senhaNova.length < 4) {
      setErroSenha("A nova senha deve ter pelo menos 4 caracteres.");
      return;
    }
    if (senhaNova !== senhaNovaConfirma) {
      setErroSenha("As senhas novas não coincidem.");
      return;
    }
    const novoHash = await hashSenha(senhaNova);
    await updateDoc(doc(db, "usuarios", currentUser.id), { senhaHash: novoHash });
    setCurrentUser({ ...currentUser, senhaHash: novoHash });
    setSenhaAtual("");
    setSenhaNova("");
    setSenhaNovaConfirma("");
    setOkSenha("Senha alterada com sucesso.");
  }

  async function registrarCaixa(e) {
    e.preventDefault();
    const nomeFinal = caixaNome === "__outro__" ? caixaCustom.trim() : caixaNome;
    if (!nomeFinal || !valor || Number(valor) <= 0) {
      setErro("Preencha o caixa e um valor válido.");
      return;
    }
    if (!dataLancamento) {
      setErro("Selecione a data do lançamento.");
      return;
    }
    await addDoc(collection(db, "registros"), {
      caixa: nomeFinal,
      valor: Number(valor),
      origem,
      registradoPor: currentUser.nome,
      registradoEm: dataComHoraAtual(dataLancamento),
      status: "pendente",
      recebidoPor: null,
      recebidoEm: null,
    });
    setValor("");
    setCaixaCustom("");
    setOrigem(ORIGENS[0]);
    setDataLancamento(hojeLocalISO());
    setErro("");
    setTab("pendentes");
  }

  function iniciarConfirmacaoRecebimento(r) {
    setConfirmandoRecebimentoId(r.id);
    setValorRecebido(String(r.valor));
    setObsRecebimento("");
    setFotoRecebimento(null);
    setErroRecebimento("");
  }

  function cancelarConfirmacaoRecebimento() {
    setConfirmandoRecebimentoId(null);
    setValorRecebido("");
    setObsRecebimento("");
    setFotoRecebimento(null);
    setErroRecebimento("");
  }

  function processarFoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxLado = 900;
          const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = img.width * escala;
          canvas.height = img.height * escala;
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.6));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function selecionarFoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setEnviandoFoto(true);
    setErroRecebimento("");
    try {
      setFotoRecebimento(await processarFoto(file));
    } catch {
      setErroRecebimento("Não foi possível carregar a foto.");
    } finally {
      setEnviandoFoto(false);
    }
  }

  async function confirmarRecebimento(r) {
    if (!valorRecebido || Number(valorRecebido) <= 0) {
      setErroRecebimento("Informe o valor recebido.");
      return;
    }
    await updateDoc(doc(db, "registros", r.id), {
      status: "recebido",
      recebidoPor: currentUser.nome,
      recebidoEm: new Date().toISOString(),
      valorRecebido: Number(valorRecebido),
      observacao: obsRecebimento.trim() || null,
      fotoRecebimento: fotoRecebimento || null,
    });
    cancelarConfirmacaoRecebimento();
  }

  async function cancelarRecebimento(id) {
    await updateDoc(doc(db, "registros", id), {
      status: "pendente",
      recebidoPor: null,
      recebidoEm: null,
      valorRecebido: null,
      observacao: null,
      fotoRecebimento: null,
    });
  }

  function iniciarEdicao(r) {
    setEditandoId(r.id);
    setEditCaixa(r.caixa);
    setEditValor(String(r.valor));
    setEditOrigem(r.origem);
    setEditData(dataLocalDeISO(r.registradoEm));
    setErroEdicao("");
  }

  function cancelarEdicao() {
    setEditandoId(null);
    setErroEdicao("");
  }

  async function salvarEdicao(e, registro) {
    e.preventDefault();
    const nome = editCaixa.trim();
    if (!nome || !editValor || Number(editValor) <= 0 || !editData) {
      setErroEdicao("Preencha caixa, valor e data corretamente.");
      return;
    }
    await updateDoc(doc(db, "registros", registro.id), {
      caixa: nome,
      valor: Number(editValor),
      origem: editOrigem,
      registradoEm: trocarDataMantendoHora(registro.registradoEm, editData),
    });
    setEditandoId(null);
    setErroEdicao("");
  }

  async function excluirRegistro(id) {
    await deleteDoc(doc(db, "registros", id));
    setExcluirConfirmId(null);
  }

  async function confirmarConferencia() {
    if (registrosSelecionados.length === 0) return;
    const batch = writeBatch(db);

    const novaConferenciaRef = doc(collection(db, "conferencias"));
    batch.set(novaConferenciaRef, {
      datas: [...datasSelecionadas].sort(),
      conferidoPor: currentUser.nome,
      conferidoEm: new Date().toISOString(),
      qtdRegistros: registrosSelecionados.length,
      total: resumoSelecao.total,
      porCaixa: resumoSelecao.porCaixaSel,
      porOrigem: resumoSelecao.porOrigemSel,
    });

    registrosSelecionados.forEach((r) => {
      batch.delete(doc(db, "registros", r.id));
    });

    await batch.commit();
    setDatasSelecionadas([]);
    setConfirmandoConferencia(false);
  }

  async function alternarAdmin(userId) {
    const alvo = usuarios.find((u) => u.id === userId);
    await updateDoc(doc(db, "usuarios", userId), { admin: !alvo.admin });
  }

  // ---------- styles ----------
  const page = {
    minHeight: "100vh",
    background: "#efe9dc",
    backgroundImage:
      "repeating-linear-gradient(0deg, rgba(0,0,0,0.015) 0px, rgba(0,0,0,0.015) 1px, transparent 1px, transparent 26px)",
    color: "#2b2620",
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    padding: "0 0 60px",
  };
  const header = {
    background: "#1f3d33",
    color: "#efe9dc",
    padding: "22px 20px 20px",
    borderBottom: "4px double #efe9dc55",
  };
  const brand = {
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "22px",
    letterSpacing: "0.5px",
    margin: 0,
  };
  const sub = { fontSize: "12px", opacity: 0.75, marginTop: "4px", fontFamily: "'Courier New', monospace" };
  const container = { maxWidth: "720px", margin: "0 auto", padding: "20px 18px" };
  const card = {
    background: "#fbf8f0",
    border: "1px solid #cfc6ae",
    borderRadius: "4px",
    padding: "18px",
    marginBottom: "18px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
    position: "relative",
  };
  const label = {
    display: "block",
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "1px",
    color: "#6b6252",
    marginBottom: "5px",
    fontFamily: "'Courier New', monospace",
  };
  const input = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    border: "1px solid #c9bfa6",
    borderRadius: "3px",
    fontSize: "15px",
    background: "#fff",
    marginBottom: "14px",
    fontFamily: "inherit",
  };
  const btnPrimary = {
    background: "#1f3d33",
    color: "#efe9dc",
    border: "none",
    padding: "11px 18px",
    borderRadius: "3px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: "0.4px",
  };
  const btnStamp = {
    background: "#8a1f1f",
    color: "#fff",
    border: "none",
    padding: "8px 14px",
    borderRadius: "3px",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
    letterSpacing: "0.5px",
    fontFamily: "'Courier New', monospace",
  };
  const tag = {
    display: "inline-block",
    fontSize: "11px",
    padding: "2px 8px",
    borderRadius: "10px",
    background: "#e4dcc4",
    color: "#5b4f36",
    fontFamily: "'Courier New', monospace",
  };
  const tagOrigem = (o) => ({
    ...tag,
    background: o === "Troco" ? "#dbe6df" : "#f0ddc4",
    color: o === "Troco" ? "#2f5240" : "#7a4d1f",
  });

  function formEdicaoRegistro(r) {
    return (
      <form onSubmit={(e) => salvarEdicao(e, r)}>
        <label style={label}>Caixa</label>
        <input style={input} value={editCaixa} onChange={(e) => setEditCaixa(e.target.value)} />
        <label style={label}>Valor</label>
        <input
          style={input}
          type="number"
          min="0"
          step="0.01"
          value={editValor}
          onChange={(e) => setEditValor(e.target.value)}
        />
        <label style={label}>Origem</label>
        <select style={input} value={editOrigem} onChange={(e) => setEditOrigem(e.target.value)}>
          {ORIGENS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <label style={label}>Data do lançamento</label>
        <input style={input} type="date" value={editData} onChange={(e) => setEditData(e.target.value)} />
        {erroEdicao && <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-8px" }}>{erroEdicao}</p>}
        <div style={{ display: "flex", gap: "10px" }}>
          <button style={btnPrimary} type="submit">
            Salvar
          </button>
          <button
            type="button"
            onClick={cancelarEdicao}
            style={{ ...btnPrimary, background: "#fff", color: "#1f3d33", border: "1px solid #1f3d33" }}
          >
            Cancelar
          </button>
        </div>
      </form>
    );
  }

  function botoesAdminRegistro(r, mostrarCancelarRecebimento = false) {
    if (!currentUser.admin) return null;
    return (
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
        <button
          type="button"
          onClick={() => iniciarEdicao(r)}
          style={{
            ...btnPrimary,
            background: "#fff",
            color: "#1f3d33",
            border: "1px solid #1f3d33",
            padding: "7px 12px",
            fontSize: "12px",
          }}
        >
          Editar
        </button>
        {mostrarCancelarRecebimento && (
          <button
            type="button"
            onClick={() => cancelarRecebimento(r.id)}
            style={{
              ...btnPrimary,
              background: "#fff",
              color: "#7a4d1f",
              border: "1px solid #7a4d1f",
              padding: "7px 12px",
              fontSize: "12px",
            }}
          >
            Cancelar recebimento
          </button>
        )}
        {excluirConfirmId === r.id ? (
          <>
            <button type="button" onClick={() => excluirRegistro(r.id)} style={{ ...btnStamp, padding: "7px 12px" }}>
              Confirmar exclusão
            </button>
            <button
              type="button"
              onClick={() => setExcluirConfirmId(null)}
              style={{
                ...btnPrimary,
                background: "#fff",
                color: "#1f3d33",
                border: "1px solid #1f3d33",
                padding: "7px 12px",
                fontSize: "12px",
              }}
            >
              Cancelar
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setExcluirConfirmId(r.id)}
            style={{
              ...btnPrimary,
              background: "#fff",
              color: "#8a1f1f",
              border: "1px solid #8a1f1f",
              padding: "7px 12px",
              fontSize: "12px",
            }}
          >
            Excluir
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...page, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ fontFamily: "'Courier New', monospace" }}>carregando registros…</p>
      </div>
    );
  }

  if (loginAlvo) {
    return (
      <div style={page}>
        <div style={header}>
          <h1 style={brand}>Livro de Caixa</h1>
          <div style={sub}>entrar como {loginAlvo.nome}</div>
        </div>
        <div style={container}>
          <div style={card}>
            <form onSubmit={confirmarLogin}>
              <label style={label}>Senha</label>
              <input
                style={input}
                type="password"
                autoFocus
                value={loginSenha}
                onChange={(e) => setLoginSenha(e.target.value)}
              />
              {erroLogin && <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-8px" }}>{erroLogin}</p>}
              <div style={{ display: "flex", gap: "10px" }}>
                <button style={btnPrimary} type="submit">
                  Entrar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLoginAlvo(null);
                    setLoginSenha("");
                    setErroLogin("");
                  }}
                  style={{ ...btnPrimary, background: "#fff", color: "#1f3d33", border: "1px solid #1f3d33" }}
                >
                  Voltar
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div style={page}>
        <div style={header}>
          <h1 style={brand}>Livro de Caixa</h1>
          <div style={sub}>controle de recebimento por atendente</div>
        </div>
        <div style={container}>
          <div style={card}>
            <p style={{ marginTop: 0, fontWeight: 600 }}>Quem é você?</p>
            {usuarios.length === 0 && (
              <p style={{ fontSize: "13px", color: "#6b6252" }}>
                Ainda não há usuários cadastrados. Cadastre o primeiro administrador abaixo.
              </p>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {usuarios.map((u) => (
                <button
                  key={u.id}
                  onClick={() => setLoginAlvo(u)}
                  style={{
                    ...btnPrimary,
                    background: "#fff",
                    color: "#1f3d33",
                    border: "1px solid #1f3d33",
                  }}
                >
                  {u.nome}
                </button>
              ))}
            </div>
          </div>

          {usuarios.length === 0 ? (
            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Cadastrar administrador</p>
              <form onSubmit={cadastrarUsuario}>
                <label style={label}>Nome do atendente</label>
                <input
                  style={input}
                  value={novoNome}
                  onChange={(e) => setNovoNome(e.target.value)}
                  placeholder="Ex: Maria"
                />
                <label style={label}>Senha</label>
                <input
                  style={input}
                  type="password"
                  value={novaSenha}
                  onChange={(e) => setNovaSenha(e.target.value)}
                  placeholder="Escolha uma senha"
                />
                {erro && <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-8px" }}>{erro}</p>}
                <button style={btnPrimary} type="submit">
                  Cadastrar e entrar
                </button>
              </form>
            </div>
          ) : (
            <p style={{ fontSize: "12px", color: "#8a7f68", textAlign: "center" }}>
              Não encontrou seu nome? Peça para um administrador cadastrar seu usuário.
            </p>
          )}
          <p style={{ fontSize: "12px", color: "#8a7f68", textAlign: "center" }}>
            Os dados ficam salvos no banco de dados e visíveis para todos que acessarem este site.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={page}>
      <div style={header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={brand}>Livro de Caixa</h1>
            <div style={sub}>logado como {currentUser.nome}</div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => {
                setMostrarAlterarSenha((v) => !v);
                setErroSenha("");
                setOkSenha("");
              }}
              style={{
                background: "transparent",
                color: "#efe9dc",
                border: "1px solid #efe9dc88",
                borderRadius: "3px",
                padding: "6px 10px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              alterar senha
            </button>
            <button
              onClick={() => setCurrentUser(null)}
              style={{
                background: "transparent",
                color: "#efe9dc",
                border: "1px solid #efe9dc88",
                borderRadius: "3px",
                padding: "6px 10px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              trocar usuário
            </button>
          </div>
        </div>
      </div>

      <div style={container}>
        {mostrarAlterarSenha && (
          <div style={card}>
            <p style={{ marginTop: 0, fontWeight: 600 }}>Alterar senha</p>
            <form onSubmit={alterarSenha}>
              <label style={label}>Senha atual</label>
              <input
                style={input}
                type="password"
                value={senhaAtual}
                onChange={(e) => setSenhaAtual(e.target.value)}
              />
              <label style={label}>Nova senha</label>
              <input
                style={input}
                type="password"
                value={senhaNova}
                onChange={(e) => setSenhaNova(e.target.value)}
              />
              <label style={label}>Confirmar nova senha</label>
              <input
                style={input}
                type="password"
                value={senhaNovaConfirma}
                onChange={(e) => setSenhaNovaConfirma(e.target.value)}
              />
              {erroSenha && <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-8px" }}>{erroSenha}</p>}
              {okSenha && <p style={{ color: "#2f5240", fontSize: "13px", marginTop: "-8px" }}>{okSenha}</p>}
              <button style={btnPrimary} type="submit">
                Salvar nova senha
              </button>
            </form>
          </div>
        )}

        <div style={card}>
          <p style={{ marginTop: 0, fontWeight: 600 }}>Registrar valor de caixa</p>
          <form onSubmit={registrarCaixa}>
            <label style={label}>Caixa</label>
            <select style={input} value={caixaNome} onChange={(e) => setCaixaNome(e.target.value)}>
              {nomesCaixaExistentes.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__outro__">Outro (digitar)</option>
            </select>
            {caixaNome === "__outro__" && (
              <input
                style={input}
                value={caixaCustom}
                onChange={(e) => setCaixaCustom(e.target.value)}
                placeholder="Nome do caixa"
              />
            )}
            <label style={label}>Valor</label>
            <input
              style={input}
              type="number"
              min="0"
              step="0.01"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="0,00"
            />
            <label style={label}>Origem</label>
            <select style={input} value={origem} onChange={(e) => setOrigem(e.target.value)}>
              {ORIGENS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <label style={label}>Data do lançamento</label>
            <input
              style={input}
              type="date"
              value={dataLancamento}
              onChange={(e) => setDataLancamento(e.target.value)}
            />
            {erro && <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-8px" }}>{erro}</p>}
            <button style={btnPrimary} type="submit">
              Registrar
            </button>
          </form>
        </div>

        <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
          <button
            onClick={() => setTab("pendentes")}
            style={{
              ...btnPrimary,
              background: tab === "pendentes" ? "#1f3d33" : "#fff",
              color: tab === "pendentes" ? "#efe9dc" : "#1f3d33",
              border: "1px solid #1f3d33",
              flex: "1 1 30%",
              fontSize: "13px",
            }}
          >
            Pendentes ({pendentes.length})
          </button>
          <button
            onClick={() => setTab("recebidos")}
            style={{
              ...btnPrimary,
              background: tab === "recebidos" ? "#1f3d33" : "#fff",
              color: tab === "recebidos" ? "#efe9dc" : "#1f3d33",
              border: "1px solid #1f3d33",
              flex: "1 1 30%",
              fontSize: "13px",
            }}
          >
            Recebidos ({recebidos.length})
          </button>
          <button
            onClick={() => setTab("relatorios")}
            style={{
              ...btnPrimary,
              background: tab === "relatorios" ? "#1f3d33" : "#fff",
              color: tab === "relatorios" ? "#efe9dc" : "#1f3d33",
              border: "1px solid #1f3d33",
              flex: "1 1 30%",
              fontSize: "13px",
            }}
          >
            Relatórios
          </button>
          {currentUser.admin && (
            <button
              onClick={() => setTab("conferencia")}
              style={{
                ...btnPrimary,
                background: tab === "conferencia" ? "#1f3d33" : "#fff",
                color: tab === "conferencia" ? "#efe9dc" : "#1f3d33",
                border: "1px solid #1f3d33",
                flex: "1 1 30%",
                fontSize: "13px",
              }}
            >
              Conferência
            </button>
          )}
        </div>

        {tab === "pendentes" && (
          <>
            <p style={{ fontSize: "12px", color: "#6b6252", marginBottom: "10px" }}>
              Total pendente: <strong>{fmtMoney(totalPendente)}</strong>
            </p>
            {pendentes.length === 0 && (
              <p style={{ fontSize: "13px", color: "#8a7f68", textAlign: "center" }}>
                Nenhum valor pendente de recebimento.
              </p>
            )}
            {pendentes.map((r) => (
              <div key={r.id} style={card}>
                {editandoId === r.id ? (
                  formEdicaoRegistro(r)
                ) : confirmandoRecebimentoId === r.id ? (
                  <>
                    <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: "16px" }}>{r.caixa}</p>
                    <p style={{ margin: "0 0 6px", fontFamily: "'Courier New', monospace", fontSize: "20px" }}>
                      {fmtMoney(r.valor)}
                    </p>
                    <span style={tagOrigem(r.origem)}>{r.origem}</span>
                    <p style={{ margin: "14px 0 0", fontWeight: 600, fontSize: "13px" }}>Confirmar recebimento</p>
                    <label style={label}>Valor recebido</label>
                    <input
                      style={input}
                      type="number"
                      min="0"
                      step="0.01"
                      value={valorRecebido}
                      onChange={(e) => setValorRecebido(e.target.value)}
                    />
                    {valorRecebido !== "" && Number(valorRecebido) !== Number(r.valor) && (
                      <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-8px", marginBottom: "14px" }}>
                        Valor diferente do registrado ({fmtMoney(r.valor)}). Explique o motivo na observação.
                      </p>
                    )}
                    <label style={label}>Observação (opcional)</label>
                    <input
                      style={input}
                      value={obsRecebimento}
                      onChange={(e) => setObsRecebimento(e.target.value)}
                      placeholder="Ex: recebido em dinheiro"
                    />
                    <label style={label}>Foto (opcional)</label>
                    <input
                      style={{ ...input, padding: "8px" }}
                      type="file"
                      accept="image/*"
                      onChange={selecionarFoto}
                    />
                    {enviandoFoto && <p style={{ fontSize: "12px", color: "#6b6252" }}>Carregando foto…</p>}
                    {fotoRecebimento && (
                      <img
                        src={fotoRecebimento}
                        alt="Foto do recebimento"
                        style={{
                          maxWidth: "100%",
                          borderRadius: "4px",
                          marginBottom: "10px",
                          border: "1px solid #cfc6ae",
                        }}
                      />
                    )}
                    {erroRecebimento && (
                      <p style={{ color: "#8a1f1f", fontSize: "13px" }}>{erroRecebimento}</p>
                    )}
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button style={btnStamp} onClick={() => confirmarRecebimento(r)}>
                        CONFIRMAR RECEBIMENTO
                      </button>
                      <button
                        type="button"
                        onClick={cancelarConfirmacaoRecebimento}
                        style={{ ...btnPrimary, background: "#fff", color: "#1f3d33", border: "1px solid #1f3d33" }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: "16px" }}>{r.caixa}</p>
                    <p style={{ margin: "0 0 6px", fontFamily: "'Courier New', monospace", fontSize: "20px" }}>
                      {fmtMoney(r.valor)}
                    </p>
                    <span style={tagOrigem(r.origem)}>{r.origem}</span>
                    <p style={{ fontSize: "12px", color: "#6b6252", marginTop: "10px", marginBottom: "12px" }}>
                      Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                    </p>
                    <button style={btnStamp} onClick={() => iniciarConfirmacaoRecebimento(r)}>
                      DAR RECEBIDO
                    </button>
                    {botoesAdminRegistro(r)}
                  </>
                )}
              </div>
            ))}
          </>
        )}

        {tab === "recebidos" && (
          <>
            {recebidos.length === 0 && (
              <p style={{ fontSize: "13px", color: "#8a7f68", textAlign: "center" }}>
                Ainda não há recebimentos confirmados.
              </p>
            )}
            {recebidosAgrupados.map(([key, itens]) => (
              <div key={key} style={{ marginBottom: "22px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    borderBottom: "2px solid #1f3d33",
                    paddingBottom: "6px",
                    marginBottom: "12px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "Georgia, 'Times New Roman', serif",
                      fontSize: "16px",
                      fontWeight: 700,
                      color: "#1f3d33",
                    }}
                  >
                    {diaLabel(key)}
                  </span>
                  <span style={{ fontSize: "12px", color: "#6b6252", fontFamily: "'Courier New', monospace" }}>
                    {itens.length} recebimento{itens.length === 1 ? "" : "s"} ·{" "}
                    {fmtMoney(itens.reduce((s, r) => s + Number(r.valor), 0))}
                  </span>
                </div>
                {itens.map((r) => (
                  <div key={r.id} style={{ ...card, overflow: "hidden" }}>
                    {editandoId === r.id ? (
                      formEdicaoRegistro(r)
                    ) : (
                      <>
                        <Stamp />
                        <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: "16px" }}>{r.caixa}</p>
                        <p style={{ margin: "0 0 6px", fontFamily: "'Courier New', monospace", fontSize: "20px" }}>
                          {fmtMoney(r.valor)}
                        </p>
                        <span style={tagOrigem(r.origem)}>{r.origem}</span>
                        {r.valorRecebido != null && Number(r.valorRecebido) !== Number(r.valor) && (
                          <p style={{ fontSize: "13px", color: "#8a1f1f", fontWeight: 700, margin: "6px 0 0" }}>
                            Valor recebido: {fmtMoney(r.valorRecebido)}
                          </p>
                        )}
                        <p style={{ fontSize: "12px", color: "#6b6252", marginTop: "10px" }}>
                          Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                          <br />
                          Recebido por <strong>{r.recebidoPor}</strong> em {fmtDateTime(r.recebidoEm)}
                        </p>
                        {r.observacao && (
                          <p style={{ fontSize: "13px", marginTop: "8px", fontStyle: "italic" }}>“{r.observacao}”</p>
                        )}
                        {r.fotoRecebimento && (
                          <img
                            src={r.fotoRecebimento}
                            alt="Foto do recebimento"
                            style={{
                              maxWidth: "100%",
                              borderRadius: "4px",
                              marginTop: "8px",
                              border: "1px solid #cfc6ae",
                            }}
                          />
                        )}
                        {botoesAdminRegistro(r, true)}
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {tab === "relatorios" && (
          <>
            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Filtros</p>
              <label style={label}>Caixa</label>
              <select style={input} value={filtroCaixa} onChange={(e) => setFiltroCaixa(e.target.value)}>
                <option value="Todos">Todos</option>
                {nomesCaixaExistentes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label style={label}>Origem</label>
              <select style={input} value={filtroOrigem} onChange={(e) => setFiltroOrigem(e.target.value)}>
                <option value="Todos">Todos</option>
                {ORIGENS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <p style={{ fontSize: "13px", margin: 0 }}>
                Total no filtro: <strong>{fmtMoney(totalFiltrado)}</strong> ({registrosFiltrados.length} registro
                {registrosFiltrados.length === 1 ? "" : "s"})
              </p>
            </div>

            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Por caixa</p>
              {Object.keys(porCaixa).length === 0 && (
                <p style={{ fontSize: "13px", color: "#8a7f68" }}>Sem registros para este filtro.</p>
              )}
              {Object.entries(porCaixa).map(([nome, dados]) => (
                <div key={nome} style={{ borderBottom: "1px solid #e4dcc4", padding: "10px 0" }}>
                  <p style={{ margin: "0 0 4px", fontWeight: 700 }}>{nome}</p>
                  <p style={{ margin: 0, fontSize: "13px", color: "#4a4436" }}>
                    Total: <strong>{fmtMoney(dados.total)}</strong> · Recebido: {fmtMoney(dados.recebido)} ·
                    Pendente: {fmtMoney(dados.pendente)} · {dados.qtd} lançamento{dados.qtd === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>

            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Por origem</p>
              {Object.keys(porOrigem).length === 0 && (
                <p style={{ fontSize: "13px", color: "#8a7f68" }}>Sem registros para este filtro.</p>
              )}
              {Object.entries(porOrigem).map(([nome, dados]) => (
                <div key={nome} style={{ borderBottom: "1px solid #e4dcc4", padding: "10px 0" }}>
                  <p style={{ margin: "0 0 6px" }}>
                    <span style={tagOrigem(nome)}>{nome}</span>
                  </p>
                  <p style={{ margin: 0, fontSize: "13px", color: "#4a4436" }}>
                    Total: <strong>{fmtMoney(dados.total)}</strong> · Recebido: {fmtMoney(dados.recebido)} ·
                    Pendente: {fmtMoney(dados.pendente)} · {dados.qtd} lançamento{dados.qtd === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "conferencia" && currentUser.admin && (
          <>
            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Selecionar dias para conferir</p>
              <p style={{ fontSize: "13px", color: "#6b6252", marginTop: "-6px" }}>
                Só entram na conferência os valores já marcados como recebidos.
              </p>
              {diasDisponiveis.length === 0 && (
                <p style={{ fontSize: "13px", color: "#8a7f68" }}>Nenhum valor recebido ainda.</p>
              )}
              {diasDisponiveis.map(([key, dados]) => (
                <label
                  key={key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 0",
                    borderBottom: "1px solid #e4dcc4",
                    fontSize: "14px",
                    cursor: "pointer",
                  }}
                >
                  <span>
                    <input
                      type="checkbox"
                      checked={datasSelecionadas.includes(key)}
                      onChange={() => toggleData(key)}
                      style={{ marginRight: "10px" }}
                    />
                    {diaLabel(key)}
                  </span>
                  <span style={{ fontFamily: "'Courier New', monospace", fontSize: "13px" }}>
                    {fmtMoney(dados.total)} · {dados.qtd} lanç.
                  </span>
                </label>
              ))}
            </div>

            {datasSelecionadas.length > 0 && (
              <div style={card}>
                <p style={{ marginTop: 0, fontWeight: 600 }}>
                  Resumo da seleção ({datasSelecionadas.length} dia{datasSelecionadas.length === 1 ? "" : "s"})
                </p>
                <p style={{ fontSize: "15px" }}>
                  Total: <strong>{fmtMoney(resumoSelecao.total)}</strong> · {registrosSelecionados.length}{" "}
                  lançamento{registrosSelecionados.length === 1 ? "" : "s"}
                </p>
                <p style={{ ...label, marginTop: "10px" }}>Por caixa</p>
                {Object.entries(resumoSelecao.porCaixaSel).map(([nome, v]) => (
                  <p key={nome} style={{ fontSize: "13px", margin: "2px 0" }}>
                    {nome}: <strong>{fmtMoney(v)}</strong>
                  </p>
                ))}
                <p style={{ ...label, marginTop: "10px" }}>Por origem</p>
                {Object.entries(resumoSelecao.porOrigemSel).map(([nome, v]) => (
                  <p key={nome} style={{ fontSize: "13px", margin: "2px 0" }}>
                    {nome}: <strong>{fmtMoney(v)}</strong>
                  </p>
                ))}

                {!confirmandoConferencia ? (
                  <button
                    style={{ ...btnStamp, marginTop: "14px" }}
                    onClick={() => setConfirmandoConferencia(true)}
                  >
                    MARCAR COMO CONFERIDO
                  </button>
                ) : (
                  <div style={{ marginTop: "14px" }}>
                    <p style={{ fontSize: "13px", color: "#8a1f1f", fontWeight: 600 }}>
                      Isso vai apagar {registrosSelecionados.length} lançamento
                      {registrosSelecionados.length === 1 ? "" : "s"} detalhado
                      {registrosSelecionados.length === 1 ? "" : "s"}. O resumo fica salvo no histórico. Confirma?
                    </p>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button style={btnStamp} onClick={confirmarConferencia}>
                        SIM, CONFIRMAR E APAGAR
                      </button>
                      <button
                        style={{ ...btnPrimary, background: "#fff", color: "#1f3d33", border: "1px solid #1f3d33" }}
                        onClick={() => setConfirmandoConferencia(false)}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Histórico de conferências</p>
              {conferencias.length === 0 && (
                <p style={{ fontSize: "13px", color: "#8a7f68" }}>Nenhuma conferência realizada ainda.</p>
              )}
              {conferencias.map((c) => (
                <div key={c.id} style={{ borderBottom: "1px solid #e4dcc4", padding: "10px 0" }}>
                  <p style={{ margin: "0 0 4px", fontWeight: 700 }}>{c.datas.map(diaLabel).join(", ")}</p>
                  <p style={{ margin: "0 0 4px", fontSize: "13px" }}>
                    Total: <strong>{fmtMoney(c.total)}</strong> · {c.qtdRegistros} lançamento
                    {c.qtdRegistros === 1 ? "" : "s"}
                  </p>
                  <p style={{ margin: 0, fontSize: "12px", color: "#6b6252" }}>
                    Conferido por <strong>{c.conferidoPor}</strong> em {fmtDateTime(c.conferidoEm)}
                  </p>
                </div>
              ))}
            </div>

            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Cadastrar novo usuário</p>
              <p style={{ fontSize: "13px", color: "#6b6252", marginTop: "-6px" }}>
                Só administradores podem cadastrar novos atendentes.
              </p>
              <form onSubmit={criarUsuario}>
                <label style={label}>Nome do atendente</label>
                <input
                  style={input}
                  value={novoNomeUser}
                  onChange={(e) => setNovoNomeUser(e.target.value)}
                  placeholder="Ex: Maria"
                />
                <label style={label}>Senha</label>
                <input
                  style={input}
                  type="password"
                  value={novaSenhaUser}
                  onChange={(e) => setNovaSenhaUser(e.target.value)}
                  placeholder="Escolha uma senha"
                />
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "13px",
                    marginBottom: "14px",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={novoUserAdmin}
                    onChange={(e) => setNovoUserAdmin(e.target.checked)}
                  />
                  Tornar administrador
                </label>
                {erroNovoUsuario && (
                  <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-8px" }}>{erroNovoUsuario}</p>
                )}
                {okNovoUsuario && (
                  <p style={{ color: "#2f5240", fontSize: "13px", marginTop: "-8px" }}>{okNovoUsuario}</p>
                )}
                <button style={btnPrimary} type="submit">
                  Cadastrar usuário
                </button>
              </form>
            </div>

            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Administradores</p>
              <p style={{ fontSize: "13px", color: "#6b6252", marginTop: "-6px" }}>
                Quem pode fazer conferência e apagar dados.
              </p>
              {usuarios.map((u) => (
                <div
                  key={u.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 0",
                    borderBottom: "1px solid #e4dcc4",
                    fontSize: "14px",
                  }}
                >
                  <span>{u.nome}</span>
                  <button
                    onClick={() => alternarAdmin(u.id)}
                    disabled={u.id === currentUser.id}
                    style={{
                      ...btnPrimary,
                      padding: "5px 10px",
                      fontSize: "12px",
                      background: u.admin ? "#1f3d33" : "#fff",
                      color: u.admin ? "#efe9dc" : "#1f3d33",
                      border: "1px solid #1f3d33",
                      opacity: u.id === currentUser.id ? 0.5 : 1,
                      cursor: u.id === currentUser.id ? "not-allowed" : "pointer",
                    }}
                  >
                    {u.admin ? "Admin" : "Tornar admin"}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
