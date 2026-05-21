import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc, query, orderBy, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyBxyOjXw1IsFp6YJVh3RXxNQy2wtS9Ujbk",
    authDomain: "restaurante-5b7f0.firebaseapp.com",
    projectId: "restaurante-5b7f0",
    storageBucket: "restaurante-5b7f0.firebasestorage.app",
    messagingSenderId: "645614966793",
    appId: "1:645614966793:web:426f615c6751d0951f40d8"
};

const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

let pedidos       = {};
let abaAtual      = 'pendente';
let somAtivado    = false;
let primeiraVez   = true;
let idsConhecidos = new Set();
let intervalId    = null;

// ── AUTH ──────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('tela-login').style.display  = 'none';
        document.getElementById('tela-painel').style.display = 'block';
        buscarPedidos();
        if (intervalId) clearInterval(intervalId);
        intervalId = setInterval(buscarPedidos, 3000);
    } else {
        document.getElementById('tela-login').style.display  = 'flex';
        document.getElementById('tela-painel').style.display = 'none';
        if (intervalId) { clearInterval(intervalId); intervalId = null; }
        // verifica se já tem dono pra mostrar/esconder botão de cadastro
        verificarPrimeiroCadastro().then(primeiro => {
            document.getElementById('btn-cadastro').style.display = primeiro ? 'block' : 'none';
        });
    }
});

async function verificarPrimeiroCadastro() {
    const snap = await getDoc(doc(db, 'config', 'dono'));
    return !snap.exists();
}

window.fazerLogin = async () => {
    const email = document.getElementById('input-email').value.trim();
    const senha = document.getElementById('input-senha').value.trim();
    const erro  = document.getElementById('erro-login');
    erro.textContent = '';
    try {
        await signInWithEmailAndPassword(auth, email, senha);
    } catch(e) {
        erro.textContent = 'Email ou senha incorretos.';
    }
};

window.fazerCadastro = async () => {
    const email = document.getElementById('input-email').value.trim();
    const senha = document.getElementById('input-senha').value.trim();
    const erro  = document.getElementById('erro-login');
    erro.textContent = '';
    if (!email || !senha) { erro.textContent = 'Preencha email e senha.'; return; }
    if (senha.length < 6) { erro.textContent = 'Senha precisa ter pelo menos 6 caracteres.'; return; }
    try {
        const primeiro = await verificarPrimeiroCadastro();
        if (!primeiro) { erro.textContent = 'Cadastro não permitido. Já existe um usuário registrado.'; return; }
        await createUserWithEmailAndPassword(auth, email, senha);
        await setDoc(doc(db, 'config', 'dono'), { email, criadoEm: serverTimestamp() });
    } catch(e) {
        erro.textContent = 'Erro ao cadastrar. Tente novamente.';
        console.error(e);
    }
};

window.fazerLogout = async () => await signOut(auth);

// ── PEDIDOS ───────────────────────────────────────────────────────────────
async function buscarPedidos() {
    try {
        const snap = await getDocs(query(collection(db,'pedidos'), orderBy('criadoEm','desc')));
        const novosIds = new Set();
        snap.docs.forEach(d => {
            novosIds.add(d.id);
            pedidos[d.id] = { _id: d.id, ...d.data() };
        });
        if (!primeiraVez) {
            novosIds.forEach(id => {
                if (!idsConhecidos.has(id) && pedidos[id].status === 'pendente') {
                    showNotif('Novo pedido! 🛎️', `${pedidos[id].cliente} — R$ ${pedidos[id].total.toFixed(2).replace('.',',')}`);
                    if (somAtivado) playBeep();
                }
            });
        }
        idsConhecidos = novosIds;
        primeiraVez   = false;
        atualizarBadges();
        renderGrid();
        const agora = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        document.getElementById('atualizado-em').textContent = `Atualizado às ${agora}`;
    } catch(e) { console.error(e); }
}

function atualizarBadges() {
    const c = { pendente:0, preparando:0, pronto:0, entregue:0 };
    Object.values(pedidos).forEach(p => { if (c[p.status] !== undefined) c[p.status]++; });
    document.getElementById('n-pendente').textContent   = c.pendente;
    document.getElementById('n-preparando').textContent = c.preparando;
    document.getElementById('n-pronto').textContent     = c.pronto;
    document.getElementById('n-entregue').textContent   = c.entregue;
}

function tempoRelativo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts.toDate().getTime()) / 1000);
    if (diff < 60)   return `há ${diff}s`;
    if (diff < 3600) return `há ${Math.floor(diff/60)}min`;
    return `há ${Math.floor(diff/3600)}h`;
}

const acoesPorStatus = {
    pendente:   p => `<button class="btn-preparar" onclick="atualizar('${p._id}','preparando')">👨‍🍳 Iniciar preparo</button>
                      <button class="btn-cancelar"  onclick="atualizar('${p._id}','cancelado')">✕ Cancelar</button>`,
    preparando: p => `<button class="btn-pronto"   onclick="atualizar('${p._id}','pronto')">✅ Marcar pronto</button>`,
    pronto:     p => `<button class="btn-entregar" onclick="atualizar('${p._id}','entregue')">📦 Marcar retirado</button>`,
    entregue:   p => `<span class="concluido-txt">Pedido concluído ✓</span>`,
};

function renderGrid() {
    const lista = Object.values(pedidos)
        .filter(p => p.status === abaAtual)
        .sort((a,b) => (a.criadoEm?.seconds||0) - (b.criadoEm?.seconds||0));
    const grid = document.getElementById('grid-pedidos');
    if (!lista.length) {
        const msgs = { pendente:'Nenhum pedido novo no momento.', preparando:'Nenhum pedido sendo preparado.', pronto:'Nenhum pedido pronto para retirada.', entregue:'Nenhum pedido entregue ainda.' };
        grid.innerHTML = `<div class="vazio"><p>${msgs[abaAtual]||''}</p></div>`;
        return;
    }
    grid.innerHTML = lista.map(p => `
        <div class="pedido-card ${p.status==='pendente'?'novo':''}">
            <div class="card-topo">
                <div>
                    <div class="card-cliente">👤 ${p.cliente}</div>
                    <div class="card-tempo">${tempoRelativo(p.criadoEm)}</div>
                </div>
                <span class="status-badge s-${p.status}">${{pendente:'⏳ Aguardando',preparando:'👨‍🍳 Preparando',pronto:'✅ Pronto',entregue:'📦 Retirado'}[p.status]||p.status}</span>
            </div>
            <div class="card-itens">
                ${p.itens.map(i=>`
                    <div class="item-linha">
                        <span><span class="item-nome-bold">${i.qtd}×</span>${i.nome}</span>
                        <span>R$ ${(i.preco*i.qtd).toFixed(2).replace('.',',')}</span>
                    </div>`).join('')}
                ${p.observacoes ? `<div class="obs-box">📝 ${p.observacoes}</div>` : ''}
            </div>
            <div class="card-total">
                <span>Total</span>
                <span>R$ ${p.total.toFixed(2).replace('.',',')}</span>
            </div>
            <div class="card-acoes">
                ${(acoesPorStatus[p.status]||acoesPorStatus.entregue)(p)}
            </div>
        </div>`).join('');
}

window.atualizar = async (id, status) => {
    try {
        await updateDoc(doc(db,'pedidos',id), { status });
        pedidos[id].status = status;
        atualizarBadges();
        renderGrid();
    } catch(e) { alert('Erro ao atualizar pedido.'); console.error(e); }
};

window.mudarAba = (aba, el) => {
    abaAtual = aba;
    document.querySelectorAll('.aba').forEach(a => a.classList.remove('ativa'));
    el.classList.add('ativa');
    renderGrid();
};

// ── LIMPAR ────────────────────────────────────────────────────────────────
window.confirmarLimpeza = () => document.getElementById('modalLimpeza').classList.add('open');
window.fecharModal      = () => document.getElementById('modalLimpeza').classList.remove('open');

window.limparConcluidos = async () => {
    fecharModal();
    const paraApagar = Object.values(pedidos).filter(p => p.status === 'entregue' || p.status === 'cancelado');
    if (!paraApagar.length) { showNotif('Nada para limpar', 'Não há pedidos concluídos ou cancelados.'); return; }
    try {
        await Promise.all(paraApagar.map(p => deleteDoc(doc(db,'pedidos',p._id))));
        paraApagar.forEach(p => delete pedidos[p._id]);
        atualizarBadges();
        renderGrid();
        showNotif('Limpeza concluída ✓', `${paraApagar.length} pedido(s) removido(s).`);
    } catch(e) { showNotif('Erro ao limpar', 'Tente novamente.'); console.error(e); }
};

// ── SOM ───────────────────────────────────────────────────────────────────
window.toggleSom = () => {
    somAtivado = !somAtivado;
    const btn = document.getElementById('btnSom');
    btn.textContent = somAtivado ? '🔔 Som: on' : '🔔 Som: off';
    btn.classList.toggle('ativo', somAtivado);
    if (somAtivado) playBeep();
};

function playBeep() {
    try {
        const ctx = new (window.AudioContext||window.webkitAudioContext)();
        [0,150,300].forEach(delay => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.frequency.value = 880;
            g.gain.setValueAtTime(.3, ctx.currentTime + delay/1000);
            g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + delay/1000 + .15);
            o.start(ctx.currentTime + delay/1000);
            o.stop(ctx.currentTime + delay/1000 + .15);
        });
    } catch(e) {}
}

// ── NOTIFICAÇÃO ───────────────────────────────────────────────────────────
function showNotif(titulo, desc) {
    document.getElementById('notif-titulo').textContent = titulo;
    document.getElementById('notif-desc').textContent   = desc;
    const n = document.getElementById('notif');
    n.classList.add('show');
    setTimeout(()=>n.classList.remove('show'), 4000);
}
