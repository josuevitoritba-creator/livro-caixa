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
const ORIGENS = ["Troco", "Caixa do dia", "Depósito"];
const CAIXAS_PADRAO = ["Saborey - Balcão", "Saborey - Delivery", "Holy"];

// Regra de lançamentos obrigatórios por dia: todo dia, exceto a folga semanal,
// precisa existir Troco e Caixa do dia de cada caixa abaixo.
const FOLGA_SEMANAL = 1; // 0 = domingo, 1 = segunda, ... 6 = sábado
const CAIXAS_OBRIGATORIOS = CAIXAS_PADRAO;
const ORIGENS_OBRIGATORIAS = ["Troco", "Caixa do dia"];
const JANELA_FALTAS_DIAS = 30;

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

// arredonda para centavos (evita ruído de ponto flutuante nas somas)
const arred = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------- datas (sempre no horário local, não em UTC) ----------
const pad2 = (n) => String(n).padStart(2, "0");
const fmtKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// "2026-11-14T01:30:00Z" -> dia local (em Santarém, 13/11 22:30)
const diaKey = (iso) => (iso ? fmtKey(new Date(iso)) : "");
const diaLabel = (key) => {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
};
const hojeKey = () => fmtKey(new Date());
const addDias = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return fmtKey(new Date(y, m - 1, d + n));
};
const diaSemana = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};
const NOMES_DIA = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

// dia a que o lançamento se refere (campo informado; antigos usam o dia do registro)
const dataRefDe = (r) => r.dataRef || diaKey(r.registradoEm);

// valor que vale nas contas: o recebido de fato (se informado), senão o lançado
const valorEf = (r) =>
  r.status === "recebido" && r.valorRecebido != null ? Number(r.valorRecebido) : Number(r.valor);
// diferença entre o recebido e o lançado (0 = bate)
const divergenciaDe = (r) =>
  r.status === "recebido" && r.valorRecebido != null ? arred(Number(r.valorRecebido) - Number(r.valor)) : 0;

// redimensiona e comprime a imagem antes de salvar (evita documentos grandes no Firestore)
function comprimirImagem(file, maxLado = 1000, qualidade = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxLado) {
          height = Math.round((height * maxLado) / width);
          width = maxLado;
        } else if (height > maxLado) {
          width = Math.round((width * maxLado) / height);
          height = maxLado;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", qualidade));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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

// mostra observação e miniatura da foto de um registro, se existirem
function DetalhesExtras({ registro, onAmpliarFoto }) {
  const dif = divergenciaDe(registro);
  if (!registro.observacao && !registro.foto && dif === 0) return null;
  return (
    <div style={{ marginTop: "8px" }}>
      {dif !== 0 && (
        <p
          style={{
            fontSize: "13px",
            fontWeight: 700,
            color: "#8a1f1f",
            background: "#f6e3e0",
            border: "1px solid #e3bcb6",
            borderRadius: "3px",
            padding: "8px 10px",
            margin: "0 0 8px",
          }}
        >
          Não bate: lançado {fmtMoney(registro.valor)}, recebido {fmtMoney(registro.valorRecebido)} (
          {dif < 0 ? "faltou" : "sobrou"} {fmtMoney(Math.abs(dif))})
        </p>
      )}
      {registro.observacao && (
        <p
          style={{
            fontSize: "13px",
            color: "#4a4436",
            background: "#f0ebd8",
            border: "1px solid #e4dcc4",
            borderRadius: "3px",
            padding: "8px 10px",
            margin: "0 0 8px",
          }}
        >
          {registro.observacao}
        </p>
      )}
      {registro.foto && (
        <img
          src={registro.foto}
          alt="Comprovante"
          onClick={() => onAmpliarFoto(registro.foto)}
          style={{
            maxWidth: "110px",
            maxHeight: "110px",
            borderRadius: "4px",
            border: "1px solid #c9bfa6",
            cursor: "pointer",
            display: "block",
          }}
        />
      )}
    </div>
  );
}

// Valor recebido - Troco - Depósito = Saldo no caixa
function BlocoCalculo({ dados, compacto = false }) {
  const linha = {
    display: "flex",
    justifyContent: "space-between",
    padding: compacto ? "2px 0" : "4px 0",
    fontSize: compacto ? "13px" : "15px",
  };
  const mono = { fontFamily: "'Courier New', monospace" };
  return (
    <div>
      <div style={linha}>
        <span>Valor recebido (Caixa do dia)</span>
        <span style={mono}>{fmtMoney(dados.recebido)}</span>
      </div>
      <div style={linha}>
        <span>(−) Total de troco</span>
        <span style={mono}>{fmtMoney(dados.troco)}</span>
      </div>
      <div style={linha}>
        <span>(−) Depósito</span>
        <span style={mono}>{fmtMoney(dados.deposito)}</span>
      </div>
      <div
        style={{
          ...linha,
          borderTop: "2px solid #1f3d33",
          marginTop: "4px",
          paddingTop: "6px",
          fontWeight: 700,
          color: dados.saldo < 0 ? "#8a1f1f" : "#1f3d33",
        }}
      >
        <span>= Saldo no caixa</span>
        <span style={mono}>{fmtMoney(dados.saldo)}</span>
      </div>
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
  const [dataCaixa, setDataCaixa] = useState(hojeKey());

  // recebimento com valor diferente do lançado
  const [recebendoDiferenteId, setRecebendoDiferenteId] = useState(null);
  const [valorRecebidoInput, setValorRecebidoInput] = useState("");
  const [erroRecebimento, setErroRecebimento] = useState("");
  const [mostrarDivergConferidas, setMostrarDivergConferidas] = useState(false);
  const [origem, setOrigem] = useState(ORIGENS[0]);
  const [observacao, setObservacao] = useState("");
  const [fotoBase64, setFotoBase64] = useState(null);
  const [processandoFoto, setProcessandoFoto] = useState(false);
  const [fotoAmpliada, setFotoAmpliada] = useState(null);

  const [filtroCaixa, setFiltroCaixa] = useState("Todos");
  const [filtroOrigem, setFiltroOrigem] = useState("Todos");
  const [filtroStatus, setFiltroStatus] = useState("Todos");
  const [tipoRelatorio, setTipoRelatorio] = useState("sintetico"); // sintetico | analitico

  const [conferencias, setConferencias] = useState([]);
  const [datasSelecionadas, setDatasSelecionadas] = useState([]);
  const [confirmandoConferencia, setConfirmandoConferencia] = useState(false);
  const [saldoContado, setSaldoContado] = useState("");
  const [erroConferencia, setErroConferencia] = useState("");
  const [conferenciaAberta, setConferenciaAberta] = useState(null);
  const [filtroConferencia, setFiltroConferencia] = useState("Todos");

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

  const totalPendente = pendentes.reduce((s, r) => s + (valorEf(r) || 0), 0);

  const nomesCaixaExistentes = useMemo(() => {
    const set = new Set(CAIXAS_PADRAO);
    registros.forEach((r) => set.add(r.caixa));
    return Array.from(set);
  }, [registros]);

  const registrosFiltrados = useMemo(() => {
    return registros.filter(
      (r) =>
        (filtroCaixa === "Todos" || r.caixa === filtroCaixa) &&
        (filtroOrigem === "Todos" || r.origem === filtroOrigem) &&
        (filtroStatus === "Todos" || r.status === filtroStatus) &&
        (filtroConferencia === "Todos" ||
          (filtroConferencia === "conferido" ? !!r.conferido : !r.conferido))
    );
  }, [registros, filtroCaixa, filtroOrigem, filtroStatus, filtroConferencia]);

  const porCaixa = useMemo(() => {
    const map = {};
    registrosFiltrados.forEach((r) => {
      if (!map[r.caixa]) map[r.caixa] = { total: 0, recebido: 0, pendente: 0, qtd: 0 };
      map[r.caixa].total += valorEf(r);
      map[r.caixa].qtd += 1;
      if (r.status === "recebido") map[r.caixa].recebido += valorEf(r);
      else map[r.caixa].pendente += valorEf(r);
    });
    return map;
  }, [registrosFiltrados]);

  const porOrigem = useMemo(() => {
    const map = {};
    registrosFiltrados.forEach((r) => {
      if (!map[r.origem]) map[r.origem] = { total: 0, recebido: 0, pendente: 0, qtd: 0 };
      map[r.origem].total += valorEf(r);
      map[r.origem].qtd += 1;
      if (r.status === "recebido") map[r.origem].recebido += valorEf(r);
      else map[r.origem].pendente += valorEf(r);
    });
    return map;
  }, [registrosFiltrados]);

  const totalFiltrado = registrosFiltrados.reduce((s, r) => s + valorEf(r), 0);

  // recebidos que ainda não passaram por conferência
  const naoConferidos = useMemo(() => recebidos.filter((r) => !r.conferido), [recebidos]);

  // caixas em que o valor recebido não bate com o valor lançado
  const divergentes = useMemo(
    () =>
      registros
        .filter((r) => divergenciaDe(r) !== 0)
        .sort((a, b) => (b.recebidoEm || "").localeCompare(a.recebidoEm || "")),
    [registros]
  );
  const divergentesAbertas = useMemo(() => divergentes.filter((r) => !r.conferido), [divergentes]);
  const divergentesVisiveis = mostrarDivergConferidas ? divergentes : divergentesAbertas;

  // dias (exceto a folga semanal) em que falta Troco e/ou Caixa do dia de algum caixa
  const faltas = useMemo(() => {
    if (registros.length === 0) return [];
    const feitos = new Set(registros.map((r) => `${dataRefDe(r)}|${r.caixa}|${r.origem}`));
    const hoje = hojeKey();
    const primeiro = registros.reduce((min, r) => {
      const k = dataRefDe(r);
      return !min || k < min ? k : min;
    }, "");
    const limite = addDias(hoje, -JANELA_FALTAS_DIAS);
    const inicio = primeiro > limite ? primeiro : limite; // não cobra antes do 1º lançamento
    const resultado = [];
    for (let k = hoje; k >= inicio; k = addDias(k, -1)) {
      if (diaSemana(k) === FOLGA_SEMANAL) continue;
      const faltando = [];
      CAIXAS_OBRIGATORIOS.forEach((cx) =>
        ORIGENS_OBRIGATORIAS.forEach((og) => {
          if (!feitos.has(`${k}|${cx}|${og}`)) faltando.push({ caixa: cx, origem: og });
        })
      );
      if (faltando.length > 0) resultado.push({ dia: k, hoje: k === hoje, faltando });
    }
    return resultado;
  }, [registros]);
  // hoje ainda está em andamento: só os dias já fechados entram no alerta
  const diasFechadosComFalta = faltas.filter((f) => !f.hoje);

  const diasDisponiveis = useMemo(() => {
    const map = {};
    naoConferidos.forEach((r) => {
      const key = diaKey(r.recebidoEm);
      if (!map[key]) map[key] = { total: 0, qtd: 0 };
      map[key].total += valorEf(r);
      map[key].qtd += 1;
    });
    return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]));
  }, [naoConferidos]);

  const recebidosAgrupados = useMemo(() => {
    const map = {};
    recebidos.forEach((r) => {
      const key = diaKey(r.recebidoEm);
      if (!map[key]) map[key] = [];
      map[key].push(r);
    });
    return Object.entries(map)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, itens]) => [
        key,
        itens.slice().sort((a, b) => (b.recebidoEm || "").localeCompare(a.recebidoEm || "")),
      ]);
  }, [recebidos]);

  const registrosSelecionados = useMemo(
    () => naoConferidos.filter((r) => datasSelecionadas.includes(diaKey(r.recebidoEm))),
    [naoConferidos, datasSelecionadas]
  );

  // Valor recebido (origem "Caixa do dia") - Troco - Depósito = Saldo no caixa
  const calcularConferencia = (lista) => {
    const novo = () => ({ recebido: 0, troco: 0, deposito: 0, saldo: 0 });
    const total = novo();
    const porCaixa = {};
    lista.forEach((r) => {
      const v = valorEf(r) || 0;
      if (!porCaixa[r.caixa]) porCaixa[r.caixa] = novo();
      [total, porCaixa[r.caixa]].forEach((a) => {
        if (r.origem === "Troco") a.troco += v;
        else if (r.origem === "Depósito") a.deposito += v;
        else a.recebido += v;
      });
    });
    const fechar = (a) => {
      a.recebido = arred(a.recebido);
      a.troco = arred(a.troco);
      a.deposito = arred(a.deposito);
      a.saldo = arred(a.recebido - a.troco - a.deposito);
    };
    fechar(total);
    Object.values(porCaixa).forEach(fechar);
    return { total, porCaixa };
  };

  const resumoSelecao = useMemo(() => {
    const calculo = calcularConferencia(registrosSelecionados);
    const somaTotal = arred(registrosSelecionados.reduce((s, r) => s + (valorEf(r) || 0), 0));
    const contado = saldoContado === "" ? null : arred(Number(saldoContado));
    const diferenca = contado === null ? null : arred(contado - calculo.total.saldo);
    return { calculo, somaTotal, contado, diferenca };
  }, [registrosSelecionados, saldoContado]);

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
    if (!nomeFinal || !valor || Number(valor) <= 0 || !dataCaixa) {
      setErro("Preencha o caixa, a data e um valor válido.");
      return;
    }
    await addDoc(collection(db, "registros"), {
      caixa: nomeFinal,
      valor: Number(valor),
      dataRef: dataCaixa,
      origem,
      observacao: observacao.trim(),
      foto: fotoBase64 || null,
      registradoPor: currentUser.nome,
      registradoEm: new Date().toISOString(),
      status: "pendente",
      recebidoPor: null,
      recebidoEm: null,
    });
    setValor("");
    setDataCaixa(hojeKey());
    setCaixaCustom("");
    setOrigem(ORIGENS[0]);
    setObservacao("");
    setFotoBase64(null);
    setErro("");
    setTab("pendentes");
  }

  async function handleFotoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessandoFoto(true);
    try {
      const dataUrl = await comprimirImagem(file);
      setFotoBase64(dataUrl);
    } catch (err) {
      setErro("Não foi possível processar a foto.");
    } finally {
      setProcessandoFoto(false);
    }
  }

  // Dá o recebido. Sem valor informado, considera que chegou exatamente o valor lançado.
  async function darRecebido(r, valorInformado) {
    const valorRecebido = valorInformado === undefined ? Number(r.valor) : arred(Number(valorInformado));
    await updateDoc(doc(db, "registros", r.id), {
      status: "recebido",
      recebidoPor: currentUser.nome,
      recebidoEm: new Date().toISOString(),
      valorRecebido,
    });
  }

  async function confirmarRecebimentoDiferente(r) {
    if (valorRecebidoInput === "" || Number(valorRecebidoInput) < 0 || Number.isNaN(Number(valorRecebidoInput))) {
      setErroRecebimento("Informe o valor que você recebeu.");
      return;
    }
    setErroRecebimento("");
    await darRecebido(r, valorRecebidoInput);
    setRecebendoDiferenteId(null);
    setValorRecebidoInput("");
  }

  // Marca os lançamentos como conferidos. NADA é apagado.
  async function confirmarConferencia() {
    if (registrosSelecionados.length === 0) return;
    setErroConferencia("");
    try {
      const agora = new Date().toISOString();
      const conferenciaRef = doc(collection(db, "conferencias"));
      const { calculo, somaTotal, contado, diferenca } = resumoSelecao;
      const ids = registrosSelecionados.map((r) => r.id);
      const TAMANHO_LOTE = 400; // limite do Firestore é 500 operações por lote

      for (let i = 0; i < ids.length; i += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        if (i === 0) {
          batch.set(conferenciaRef, {
            datas: [...datasSelecionadas].sort(),
            conferidoPor: currentUser.nome,
            conferidoEm: agora,
            qtdRegistros: ids.length,
            total: somaTotal,
            calculo: calculo.total,
            calculoPorCaixa: calculo.porCaixa,
            saldoContado: contado,
            diferenca,
          });
        }
        ids.slice(i, i + TAMANHO_LOTE).forEach((id) => {
          batch.update(doc(db, "registros", id), {
            conferido: true,
            conferenciaId: conferenciaRef.id,
            conferidoEm: agora,
            conferidoPor: currentUser.nome,
          });
        });
        await batch.commit();
      }

      setDatasSelecionadas([]);
      setSaldoContado("");
      setConfirmandoConferencia(false);
    } catch (err) {
      console.error(err);
      setErroConferencia("Não foi possível concluir a conferência. Tente novamente.");
    }
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
  const coresOrigem = {
    Troco: { background: "#dbe6df", color: "#2f5240" },
    "Caixa do dia": { background: "#f0ddc4", color: "#7a4d1f" },
    "Depósito": { background: "#d9e3f0", color: "#2a4a73" },
  };
  const tagOrigem = (o) => ({
    ...tag,
    ...(coresOrigem[o] || { background: "#e4dcc4", color: "#5b4f36" }),
  });

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
                Ainda não há usuários cadastrados. Cadastre o primeiro abaixo.
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

          <div style={card}>
            <p style={{ marginTop: 0, fontWeight: 600 }}>Cadastrar novo usuário</p>
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
        {diasFechadosComFalta.length > 0 && tab !== "faltas" && (
          <div
            onClick={() => setTab("faltas")}
            style={{
              background: "#f6e3e0",
              border: "1px solid #e3bcb6",
              borderRadius: "4px",
              padding: "12px 14px",
              marginBottom: "18px",
              cursor: "pointer",
              color: "#8a1f1f",
              fontSize: "14px",
              fontWeight: 600,
            }}
          >
            Faltam lançamentos em {diasFechadosComFalta.length} dia
            {diasFechadosComFalta.length === 1 ? "" : "s"} (mais recente:{" "}
            {diaLabel(diasFechadosComFalta[0].dia)}). Toque para ver.
          </div>
        )}

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
            <label style={label}>Data do caixa</label>
            <input
              style={input}
              type="date"
              value={dataCaixa}
              onChange={(e) => setDataCaixa(e.target.value)}
            />
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
            <label style={label}>Observação (opcional)</label>
            <textarea
              style={{ ...input, minHeight: "60px", resize: "vertical", fontFamily: "inherit" }}
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Ex: nota fiscal cancelada, diferença de troco, etc."
            />
            <label style={label}>Foto (opcional)</label>
            <input
              style={{ ...input, padding: "8px" }}
              type="file"
              accept="image/*"
              onChange={handleFotoChange}
            />
            {processandoFoto && (
              <p style={{ fontSize: "12px", color: "#6b6252", marginTop: "-8px" }}>processando foto…</p>
            )}
            {fotoBase64 && !processandoFoto && (
              <div style={{ marginBottom: "14px", position: "relative", display: "inline-block" }}>
                <img
                  src={fotoBase64}
                  alt="Pré-visualização"
                  style={{ maxWidth: "140px", maxHeight: "140px", borderRadius: "4px", border: "1px solid #c9bfa6" }}
                />
                <button
                  type="button"
                  onClick={() => setFotoBase64(null)}
                  style={{
                    position: "absolute",
                    top: "-8px",
                    right: "-8px",
                    background: "#8a1f1f",
                    color: "#fff",
                    border: "none",
                    borderRadius: "50%",
                    width: "22px",
                    height: "22px",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  ×
                </button>
              </div>
            )}
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
          <button
            onClick={() => setTab("faltas")}
            style={{
              ...btnPrimary,
              background: tab === "faltas" ? "#1f3d33" : "#fff",
              color: tab === "faltas" ? "#efe9dc" : diasFechadosComFalta.length > 0 ? "#8a1f1f" : "#1f3d33",
              border: `1px solid ${tab !== "faltas" && diasFechadosComFalta.length > 0 ? "#8a1f1f" : "#1f3d33"}`,
              flex: "1 1 30%",
              fontSize: "13px",
            }}
          >
            Faltas ({diasFechadosComFalta.length})
          </button>
          <button
            onClick={() => setTab("divergencias")}
            style={{
              ...btnPrimary,
              background: tab === "divergencias" ? "#1f3d33" : "#fff",
              color: tab === "divergencias" ? "#efe9dc" : divergentesAbertas.length > 0 ? "#8a1f1f" : "#1f3d33",
              border: `1px solid ${tab !== "divergencias" && divergentesAbertas.length > 0 ? "#8a1f1f" : "#1f3d33"}`,
              flex: "1 1 30%",
              fontSize: "13px",
            }}
          >
            Divergências ({divergentesAbertas.length})
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
                <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: "16px" }}>{r.caixa}</p>
                <p style={{ margin: "0 0 6px", fontFamily: "'Courier New', monospace", fontSize: "20px" }}>
                  {fmtMoney(r.valor)}
                </p>
                <span style={tagOrigem(r.origem)}>{r.origem}</span>
                <DetalhesExtras registro={r} onAmpliarFoto={setFotoAmpliada} />
                <p style={{ fontSize: "12px", color: "#6b6252", marginTop: "10px", marginBottom: "12px" }}>
                  Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                </p>
                {recebendoDiferenteId === r.id ? (
                  <div>
                    <label style={label}>Valor realmente recebido</label>
                    <input
                      style={input}
                      type="number"
                      min="0"
                      step="0.01"
                      autoFocus
                      value={valorRecebidoInput}
                      onChange={(e) => setValorRecebidoInput(e.target.value)}
                    />
                    {valorRecebidoInput !== "" && arred(Number(valorRecebidoInput) - Number(r.valor)) !== 0 && (
                      <p style={{ fontSize: "13px", fontWeight: 700, color: "#8a1f1f", marginTop: "-6px" }}>
                        {arred(Number(valorRecebidoInput) - Number(r.valor)) < 0 ? "Faltou" : "Sobrou"}{" "}
                        {fmtMoney(Math.abs(arred(Number(valorRecebidoInput) - Number(r.valor))))} em relação ao
                        lançado ({fmtMoney(r.valor)})
                      </p>
                    )}
                    {erroRecebimento && (
                      <p style={{ color: "#8a1f1f", fontSize: "13px", marginTop: "-6px" }}>{erroRecebimento}</p>
                    )}
                    <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                      <button style={btnStamp} onClick={() => confirmarRecebimentoDiferente(r)}>
                        CONFIRMAR RECEBIMENTO
                      </button>
                      <button
                        style={{ ...btnPrimary, background: "#fff", color: "#1f3d33", border: "1px solid #1f3d33" }}
                        onClick={() => {
                          setRecebendoDiferenteId(null);
                          setErroRecebimento("");
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <button style={btnStamp} onClick={() => darRecebido(r)}>
                      DAR RECEBIDO
                    </button>
                    <button
                      style={{ ...btnStamp, background: "#fff", color: "#8a1f1f", border: "1px solid #8a1f1f" }}
                      onClick={() => {
                        setRecebendoDiferenteId(r.id);
                        setValorRecebidoInput(String(r.valor));
                        setErroRecebimento("");
                      }}
                    >
                      VALOR DIFERENTE
                    </button>
                  </div>
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
                    {fmtMoney(itens.reduce((s, r) => s + valorEf(r), 0))}
                  </span>
                </div>
                {itens.map((r) => (
                  <div key={r.id} style={{ ...card, overflow: "hidden" }}>
                    <Stamp label={r.conferido ? "CONFERIDO" : "RECEBIDO"} />
                    <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: "16px" }}>{r.caixa}</p>
                    <p style={{ margin: "0 0 6px", fontFamily: "'Courier New', monospace", fontSize: "20px" }}>
                      {fmtMoney(valorEf(r))}
                    </p>
                    <span style={tagOrigem(r.origem)}>{r.origem}</span>
                    <DetalhesExtras registro={r} onAmpliarFoto={setFotoAmpliada} />
                    <p style={{ fontSize: "12px", color: "#6b6252", marginTop: "10px" }}>
                      Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                      <br />
                      Recebido por <strong>{r.recebidoPor}</strong> em {fmtDateTime(r.recebidoEm)}
                      {r.conferido && (
                        <>
                          <br />
                          Conferido por <strong>{r.conferidoPor}</strong> em {fmtDateTime(r.conferidoEm)}
                        </>
                      )}
                    </p>
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
              <label style={label}>Status</label>
              <select style={input} value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
                <option value="Todos">Todos</option>
                <option value="pendente">Pendente</option>
                <option value="recebido">Recebido</option>
              </select>
              <label style={label}>Conferência</label>
              <select
                style={input}
                value={filtroConferencia}
                onChange={(e) => setFiltroConferencia(e.target.value)}
              >
                <option value="Todos">Todos</option>
                <option value="conferido">Conferidos</option>
                <option value="nao_conferido">Não conferidos</option>
              </select>
              <p style={{ fontSize: "13px", margin: 0 }}>
                Total no filtro: <strong>{fmtMoney(totalFiltrado)}</strong> ({registrosFiltrados.length} registro
                {registrosFiltrados.length === 1 ? "" : "s"})
              </p>
            </div>

            <div style={{ display: "flex", gap: "8px", marginBottom: "18px" }}>
              <button
                onClick={() => setTipoRelatorio("sintetico")}
                style={{
                  ...btnPrimary,
                  background: tipoRelatorio === "sintetico" ? "#1f3d33" : "#fff",
                  color: tipoRelatorio === "sintetico" ? "#efe9dc" : "#1f3d33",
                  border: "1px solid #1f3d33",
                  flex: 1,
                  fontSize: "13px",
                }}
              >
                Sintético
              </button>
              <button
                onClick={() => setTipoRelatorio("analitico")}
                style={{
                  ...btnPrimary,
                  background: tipoRelatorio === "analitico" ? "#1f3d33" : "#fff",
                  color: tipoRelatorio === "analitico" ? "#efe9dc" : "#1f3d33",
                  border: "1px solid #1f3d33",
                  flex: 1,
                  fontSize: "13px",
                }}
              >
                Analítico
              </button>
            </div>

            {tipoRelatorio === "sintetico" && (
              <>
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

            {tipoRelatorio === "analitico" && (
              <div style={card}>
                <p style={{ marginTop: 0, fontWeight: 600 }}>
                  Lançamentos ({registrosFiltrados.length})
                </p>
                {registrosFiltrados.length === 0 && (
                  <p style={{ fontSize: "13px", color: "#8a7f68" }}>Sem registros para este filtro.</p>
                )}
                {registrosFiltrados
                  .slice()
                  .sort((a, b) => (b.registradoEm || "").localeCompare(a.registradoEm || ""))
                  .map((r) => (
                    <div key={r.id} style={{ borderBottom: "1px solid #e4dcc4", padding: "10px 0" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "4px",
                        }}
                      >
                        <span style={{ fontWeight: 700, fontSize: "14px" }}>{r.caixa}</span>
                        <span style={{ fontFamily: "'Courier New', monospace", fontSize: "15px" }}>
                          {fmtMoney(valorEf(r))}
                        </span>
                      </div>
                      <span style={tagOrigem(r.origem)}>{r.origem}</span>{" "}
                      <span
                        style={{
                          ...tag,
                          background: r.status === "recebido" ? "#dbe6df" : "#f0ddc4",
                          color: r.status === "recebido" ? "#2f5240" : "#7a4d1f",
                        }}
                      >
                        {r.status === "recebido" ? "Recebido" : "Pendente"}
                      </span>
                      {r.conferido && (
                        <>
                          {" "}
                          <span style={{ ...tag, background: "#d9e3f0", color: "#2a4a73" }}>Conferido</span>
                        </>
                      )}
                      <DetalhesExtras registro={r} onAmpliarFoto={setFotoAmpliada} />
                      <p style={{ fontSize: "12px", color: "#6b6252", margin: "8px 0 0" }}>
                        Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                        {r.status === "recebido" && (
                          <>
                            <br />
                            Recebido por <strong>{r.recebidoPor}</strong> em {fmtDateTime(r.recebidoEm)}
                          </>
                        )}
                        {r.conferido && (
                          <>
                            <br />
                            Conferido por <strong>{r.conferidoPor}</strong> em {fmtDateTime(r.conferidoEm)}
                          </>
                        )}
                      </p>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}

        {tab === "faltas" && (
          <>
            <p style={{ fontSize: "13px", color: "#6b6252", marginTop: 0 }}>
              Regra: todo dia, exceto {NOMES_DIA[FOLGA_SEMANAL]}, precisa ter <strong>Troco</strong> e{" "}
              <strong>Caixa do dia</strong> de {CAIXAS_OBRIGATORIOS.join(", ")}. Verificando os últimos{" "}
              {JANELA_FALTAS_DIAS} dias (a partir do primeiro lançamento).
            </p>
            {faltas.length === 0 && (
              <div style={card}>
                <p style={{ margin: 0, color: "#2f5240", fontWeight: 600 }}>
                  Tudo em dia: nenhum lançamento faltando.
                </p>
              </div>
            )}
            {faltas.map((f) => (
              <div
                key={f.dia}
                style={{ ...card, borderLeft: `4px solid ${f.hoje ? "#b08a2e" : "#8a1f1f"}` }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700 }}>
                    {diaLabel(f.dia)} · {NOMES_DIA[diaSemana(f.dia)]}
                  </span>
                  <span
                    style={{
                      ...tag,
                      background: f.hoje ? "#f3e8c6" : "#f6e3e0",
                      color: f.hoje ? "#7a5d12" : "#8a1f1f",
                    }}
                  >
                    {f.hoje ? "hoje, em andamento" : `${f.faltando.length} faltando`}
                  </span>
                </div>
                {f.faltando.map((x) => (
                  <p key={`${x.caixa}|${x.origem}`} style={{ fontSize: "14px", margin: "8px 0 0" }}>
                    {x.caixa} · <span style={tagOrigem(x.origem)}>{x.origem}</span>
                  </p>
                ))}
              </div>
            ))}
          </>
        )}

        {tab === "divergencias" && (
          <>
            <p style={{ fontSize: "13px", color: "#6b6252", marginTop: 0 }}>
              Caixas em que o valor recebido não bate com o valor lançado.
              {divergentesVisiveis.length > 0 && (
                <>
                  {" "}
                  Soma das diferenças:{" "}
                  <strong>
                    {fmtMoney(arred(divergentesVisiveis.reduce((s, r) => s + divergenciaDe(r), 0)))}
                  </strong>
                  .
                </>
              )}
            </p>
            <label style={{ display: "block", fontSize: "13px", marginBottom: "14px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={mostrarDivergConferidas}
                onChange={(e) => setMostrarDivergConferidas(e.target.checked)}
                style={{ marginRight: "8px" }}
              />
              Mostrar também as já conferidas
            </label>
            {divergentesVisiveis.length === 0 && (
              <div style={card}>
                <p style={{ margin: 0, color: "#2f5240", fontWeight: 600 }}>Nenhuma divergência.</p>
              </div>
            )}
            {divergentesVisiveis.map((r) => (
              <div key={r.id} style={{ ...card, borderLeft: "4px solid #8a1f1f" }}>
                <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: "16px" }}>{r.caixa}</p>
                <span style={tagOrigem(r.origem)}>{r.origem}</span>{" "}
                <span style={tag}>{diaLabel(dataRefDe(r))}</span>
                {r.conferido && (
                  <>
                    {" "}
                    <span style={{ ...tag, background: "#d9e3f0", color: "#2a4a73" }}>Conferido</span>
                  </>
                )}
                <DetalhesExtras registro={r} onAmpliarFoto={setFotoAmpliada} />
                <p style={{ fontSize: "12px", color: "#6b6252", margin: "8px 0 0" }}>
                  Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                  <br />
                  Recebido por <strong>{r.recebidoPor}</strong> em {fmtDateTime(r.recebidoEm)}
                </p>
              </div>
            ))}
          </>
        )}

        {tab === "conferencia" && currentUser.admin && (
          <>
            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Selecionar dias para conferir</p>
              <p style={{ fontSize: "13px", color: "#6b6252", marginTop: "-6px" }}>
                Só entram valores já recebidos e ainda não conferidos. Nada é apagado: os lançamentos
                ficam marcados como conferidos.
              </p>
              {diasDisponiveis.length === 0 && (
                <p style={{ fontSize: "13px", color: "#8a7f68" }}>Nenhum valor recebido aguardando conferência.</p>
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
                  Cálculo da conferência ({datasSelecionadas.length} dia{datasSelecionadas.length === 1 ? "" : "s"})
                </p>
                <p style={{ fontSize: "12px", color: "#6b6252", marginTop: "-8px" }}>
                  {registrosSelecionados.length} lançamento{registrosSelecionados.length === 1 ? "" : "s"} · soma
                  de tudo: {fmtMoney(resumoSelecao.somaTotal)}
                </p>

                <BlocoCalculo dados={resumoSelecao.calculo.total} />

                <label style={{ ...label, marginTop: "16px" }}>Saldo contado no caixa (opcional)</label>
                <input
                  style={input}
                  type="number"
                  step="0.01"
                  value={saldoContado}
                  onChange={(e) => setSaldoContado(e.target.value)}
                  placeholder="0,00"
                />
                {resumoSelecao.diferenca !== null && (
                  <p
                    style={{
                      fontSize: "14px",
                      fontWeight: 700,
                      marginTop: "-6px",
                      color: resumoSelecao.diferenca === 0 ? "#2f5240" : "#8a1f1f",
                    }}
                  >
                    {resumoSelecao.diferenca === 0
                      ? "Confere: o saldo contado é igual ao calculado."
                      : `Diferença de ${fmtMoney(Math.abs(resumoSelecao.diferenca))} (${
                          resumoSelecao.diferenca > 0 ? "sobra" : "falta"
                        } no caixa)`}
                  </p>
                )}

                <p style={{ ...label, marginTop: "14px" }}>Por caixa</p>
                {Object.entries(resumoSelecao.calculo.porCaixa).map(([nome, dados]) => (
                  <div key={nome} style={{ borderTop: "1px solid #e4dcc4", padding: "8px 0" }}>
                    <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: "14px" }}>{nome}</p>
                    <BlocoCalculo dados={dados} compacto />
                  </div>
                ))}

                {erroConferencia && (
                  <p style={{ color: "#8a1f1f", fontSize: "13px" }}>{erroConferencia}</p>
                )}

                {!confirmandoConferencia ? (
                  <button
                    style={{ ...btnStamp, marginTop: "14px" }}
                    onClick={() => setConfirmandoConferencia(true)}
                  >
                    MARCAR COMO CONFERIDO
                  </button>
                ) : (
                  <div style={{ marginTop: "14px" }}>
                    <p style={{ fontSize: "13px", color: "#1f3d33", fontWeight: 600 }}>
                      Isso marca {registrosSelecionados.length} lançamento
                      {registrosSelecionados.length === 1 ? "" : "s"} como conferido
                      {registrosSelecionados.length === 1 ? "" : "s"} e salva o cálculo no histórico. Nenhum
                      lançamento é apagado. Confirma?
                    </p>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button style={btnStamp} onClick={confirmarConferencia}>
                        SIM, CONFIRMAR CONFERÊNCIA
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

            {datasSelecionadas.length > 0 && (
              <div style={card}>
                <p style={{ marginTop: 0, fontWeight: 600 }}>
                  Lançamentos incluídos ({registrosSelecionados.length})
                </p>
                <p style={{ fontSize: "12px", color: "#6b6252", marginTop: "-8px" }}>
                  Confira cada registro antes de confirmar a conferência.
                </p>
                {registrosSelecionados
                  .slice()
                  .sort((a, b) => (a.recebidoEm || "").localeCompare(b.recebidoEm || ""))
                  .map((r) => (
                    <div key={r.id} style={{ borderBottom: "1px solid #e4dcc4", padding: "10px 0" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "4px",
                        }}
                      >
                        <span style={{ fontWeight: 700, fontSize: "14px" }}>{r.caixa}</span>
                        <span style={{ fontFamily: "'Courier New', monospace", fontSize: "15px" }}>
                          {fmtMoney(valorEf(r))}
                        </span>
                      </div>
                      <span style={tagOrigem(r.origem)}>{r.origem}</span>
                      <DetalhesExtras registro={r} onAmpliarFoto={setFotoAmpliada} />
                      <p style={{ fontSize: "12px", color: "#6b6252", margin: "8px 0 0" }}>
                        Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                        <br />
                        Recebido por <strong>{r.recebidoPor}</strong> em {fmtDateTime(r.recebidoEm)}
                      </p>
                    </div>
                  ))}
              </div>
            )}

            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Histórico de conferências</p>
              {conferencias.length === 0 && (
                <p style={{ fontSize: "13px", color: "#8a7f68" }}>Nenhuma conferência realizada ainda.</p>
              )}
              {conferencias.map((c) => {
                const itens = registros.filter((r) => r.conferenciaId === c.id);
                const aberta = conferenciaAberta === c.id;
                return (
                  <div key={c.id} style={{ borderBottom: "1px solid #e4dcc4", padding: "12px 0" }}>
                    <p style={{ margin: "0 0 6px", fontWeight: 700 }}>{c.datas.map(diaLabel).join(", ")}</p>
                    {c.calculo ? (
                      <BlocoCalculo dados={c.calculo} compacto />
                    ) : (
                      <p style={{ margin: "0 0 4px", fontSize: "13px" }}>
                        Total: <strong>{fmtMoney(c.total)}</strong> (conferência anterior, só com resumo)
                      </p>
                    )}
                    {c.saldoContado != null && (
                      <p
                        style={{
                          margin: "6px 0 0",
                          fontSize: "13px",
                          color: c.diferenca === 0 ? "#2f5240" : "#8a1f1f",
                          fontWeight: 600,
                        }}
                      >
                        Saldo contado: {fmtMoney(c.saldoContado)} ·{" "}
                        {c.diferenca === 0
                          ? "confere"
                          : `diferença de ${fmtMoney(Math.abs(c.diferenca))} (${
                              c.diferenca > 0 ? "sobra" : "falta"
                            })`}
                      </p>
                    )}
                    <p style={{ margin: "6px 0 0", fontSize: "12px", color: "#6b6252" }}>
                      {c.qtdRegistros} lançamento{c.qtdRegistros === 1 ? "" : "s"} · conferido por{" "}
                      <strong>{c.conferidoPor}</strong> em {fmtDateTime(c.conferidoEm)}
                    </p>
                    {itens.length > 0 && (
                      <button
                        onClick={() => setConferenciaAberta(aberta ? null : c.id)}
                        style={{
                          ...btnPrimary,
                          marginTop: "8px",
                          padding: "5px 10px",
                          fontSize: "12px",
                          background: "#fff",
                          color: "#1f3d33",
                          border: "1px solid #1f3d33",
                        }}
                      >
                        {aberta ? "ocultar lançamentos" : "ver lançamentos"}
                      </button>
                    )}
                    {aberta &&
                      itens
                        .slice()
                        .sort((a, b) => (a.recebidoEm || "").localeCompare(b.recebidoEm || ""))
                        .map((r) => (
                          <div
                            key={r.id}
                            style={{ background: "#f6f2e6", borderRadius: "3px", padding: "10px", marginTop: "8px" }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                              <span style={{ fontWeight: 700, fontSize: "14px" }}>{r.caixa}</span>
                              <span style={{ fontFamily: "'Courier New', monospace", fontSize: "15px" }}>
                                {fmtMoney(valorEf(r))}
                              </span>
                            </div>
                            <span style={tagOrigem(r.origem)}>{r.origem}</span>
                            <DetalhesExtras registro={r} onAmpliarFoto={setFotoAmpliada} />
                            <p style={{ fontSize: "12px", color: "#6b6252", margin: "8px 0 0" }}>
                              Registrado por <strong>{r.registradoPor}</strong> em {fmtDateTime(r.registradoEm)}
                              <br />
                              Recebido por <strong>{r.recebidoPor}</strong> em {fmtDateTime(r.recebidoEm)}
                            </p>
                          </div>
                        ))}
                  </div>
                );
              })}
            </div>

            <div style={card}>
              <p style={{ marginTop: 0, fontWeight: 600 }}>Administradores</p>
              <p style={{ fontSize: "13px", color: "#6b6252", marginTop: "-6px" }}>
                Quem pode fazer a conferência.
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

      {fotoAmpliada && (
        <div
          onClick={() => setFotoAmpliada(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20,16,10,0.88)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "24px",
            cursor: "zoom-out",
          }}
        >
          <img
            src={fotoAmpliada}
            alt="Comprovante ampliado"
            style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: "6px" }}
          />
        </div>
      )}
    </div>
  );
}
