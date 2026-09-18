import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, getDocs, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, onSnapshot }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword }
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

let pedidos          = {};
let abaAtual         = 'pendente';
let somAtivado       = false;
let primeiraVez      = true;
let unsubscribePedidos = null; // referência do listener em tempo real, pra poder desligar no logout
let lojaAberta        = true; // estado local, sincronizado com o Firestore abaixo

// ── NOTIFICAÇÕES DO NAVEGADOR ────────────────────────────────────────────
// Pede permissão assim que o painel carrega (o navegador só pergunta uma
// vez; depois disso lembra a resposta do usuário).
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

function notificarSistema(titulo, corpo) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(titulo, { body: corpo });
    }
}

// ── AUTH ──────────────────────────────────────────────────────────────────
// Cadastro público foi removido de propósito: a única conta autorizada
// é criada manualmente pelo dono no Firebase Console (Authentication > Users).
// Isso fecha a brecha de qualquer pessoa criar login e virar "autenticado".
//
// ATENCAO: existe um bloco de CADASTRO TEMPORARIO mais abaixo, marcado com
// "REMOVER DEPOIS". Ele reabre essa brecha de proposito, so para permitir
// a criacao da primeira conta. Assim que a conta for criada, apague o bloco
// inteiro (JS aqui embaixo e o link/botao no index.html) e volte a criar
// contas novas manualmente pelo Firebase Console.
onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('tela-login').style.display  = 'none';
        document.getElementById('tela-painel').style.display = 'block';
        if (unsubscribePedidos) unsubscribePedidos();
        escutarPedidos();
    } else {
        document.getElementById('tela-login').style.display  = 'flex';
        document.getElementById('tela-painel').style.display = 'none';
        if (unsubscribePedidos) { unsubscribePedidos(); unsubscribePedidos = null; }
        primeiraVez = true; // reseta pra próxima vez que alguém logar
        pedidos = {};
    }
});

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

window.fazerLogout = async () => await signOut(auth);

// Recuperação de senha: usa o fluxo nativo do Firebase, que só envia
// e-mail de troca para contas que JÁ existem. Não cria conta nova,
// então não reabre a brecha de cadastro livre que corrigimos antes.
window.fazerResetSenha = () => {
    const email = document.getElementById('input-email').value.trim();
    const erro  = document.getElementById('erro-login');
    const msg   = document.getElementById('msg-login');
    erro.textContent = '';
    msg.textContent  = '';

    if (!email) {
        erro.textContent = 'Digite seu email no campo acima antes de clicar em "Esqueci minha senha".';
        return false;
    }

    sendPasswordResetEmail(auth, email)
        .then(() => {
            msg.textContent = 'Se esse email estiver cadastrado, enviamos um link para redefinir a senha. Verifique sua caixa de entrada.';
        })
        .catch(() => {
            msg.textContent = 'Se esse email estiver cadastrado, enviamos um link para redefinir a senha. Verifique sua caixa de entrada.';
        });

    return false;
};

// ══════════════════════════════════════════════════════════════════════════
// INICIO DO BLOCO TEMPORARIO DE CADASTRO — REMOVER DEPOIS
// Use uma unica vez para criar a primeira conta. Depois disso, apague esta
// funcao inteira, o import de createUserWithEmailAndPassword la em cima, e
// o link/botao "Criar conta" no index.html.
// ══════════════════════════════════════════════════════════════════════════
window.criarContaTemporario = async () => {
    const email = document.getElementById('input-email').value.trim();
    const senha = document.getElementById('input-senha').value.trim();
    const erro  = document.getElementById('erro-login');
    const msg   = document.getElementById('msg-login');
    erro.textContent = '';
    msg.textContent  = '';

    if (!email || !senha) {
        erro.textContent = 'Preencha email e senha antes de clicar em "Criar conta".';
        return false;
    }
    if (senha.length < 6) {
        erro.textContent = 'A senha precisa ter pelo menos 6 caracteres.';
        return false;
    }

    try {
        await createUserWithEmailAndPassword(auth, email, senha);
        msg.textContent = 'Conta criada! Pode fazer login normalmente agora.';
    } catch (e) {
        if (e.code === 'auth/email-already-in-use') {
            erro.textContent = 'Já existe uma conta com esse email.';
        } else {
            erro.textContent = 'Não foi possível criar a conta: ' + e.code;
        }
    }
    return false;
};
// ══════════════════════════════════════════════════════════════════════════
// FIM DO BLOCO TEMPORARIO DE CADASTRO — REMOVER DEPOIS
// ══════════════════════════════════════════════════════════════════════════

// ── STATUS DA LOJA (ABERTO/FECHADO) ─────────────────────────────────────
// Escuta em tempo real o documento config/loja. Assim que o painel abre
// (usuário logado), já mostra o status atual e mantém sincronizado caso
// seja alterado de outro dispositivo.
onSnapshot(doc(db, 'config', 'loja'), (snap) => {
    lojaAberta = snap.exists() ? (snap.data().aberto !== false) : true; // default: aberto
    atualizarBotaoLoja();
});

function atualizarBotaoLoja() {
    const btn = document.getElementById('btnLoja');
    if (!btn) return;
    if (lojaAberta) {
        btn.textContent = '🟢 Loja: Aberta';
        btn.classList.remove('loja-fechada');
        btn.classList.add('loja-aberta');
    } else {
        btn.textContent = '🔴 Loja: Fechada';
        btn.classList.remove('loja-aberta');
        btn.classList.add('loja-fechada');
    }
}

window.toggleLoja = async () => {
    const novoStatus = !lojaAberta;
    try {
        await setDoc(doc(db, 'config', 'loja'), { aberto: novoStatus, atualizadoEm: serverTimestamp() }, { merge: true });
        showNotif(novoStatus ? 'Loja aberta ✓' : 'Loja fechada ✓', novoStatus ? 'Clientes já podem fazer pedidos.' : 'Clientes não conseguem mais pedir até você reabrir.');
    } catch(e) {
        showNotif('Erro ao atualizar', 'Tente novamente.');
        console.error(e);
    }
};

// ── PEDIDOS (tempo real, sem polling) ───────────────────────────────────
// Antes isso rodava num setInterval de 3 em 3 segundos chamando getDocs
// (busca completa da coleção inteira toda vez — caro em leitura e lento
// pra atualizar). Agora é um único listener onSnapshot: ele lê tudo uma
// vez ao conectar e, depois disso, só recebe o que realmente mudou.
function escutarPedidos() {
    const pedidosQuery = query(collection(db, 'pedidos'), orderBy('criadoEm', 'desc'));

    unsubscribePedidos = onSnapshot(pedidosQuery, (snap) => {
        snap.docs.forEach(d => {
            pedidos[d.id] = { _id: d.id, ...d.data() };
        });

        // Notifica só pedido pendente que É NOVO de verdade (não dispara
        // pra tudo que já existia quando o painel abriu).
        if (!primeiraVez) {
            snap.docChanges().forEach(change => {
                if (change.type === 'added') {
                    const p = pedidos[change.doc.id];
                    if (p && p.status === 'pendente') {
                        const msg = `${p.cliente} — R$ ${p.total.toFixed(2).replace('.', ',')}`;
                        showNotif('Novo pedido! 🛎️', msg);
                        notificarSistema('Novo pedido! 🛎️', msg);
                        if (somAtivado) playBeep();
                    }
                }
            });
        }
        primeiraVez = false;

        atualizarBadges();
        if (abaAtual !== 'cardapio') renderGrid();
        const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        document.getElementById('atualizado-em').textContent = `Atualizado às ${agora}`;
    }, (erro) => {
        console.error('Erro no listener de pedidos:', erro);
    });
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
            ${p.tipo === 'entrega'
                ? `<div class="obs-box">🛵 Entrega: ${p.enderecoEntrega || 'não informado'}</div>`
                : `<div class="obs-box">🏠 Retirada no local</div>`}
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
    if (aba === 'cardapio') {
        carregarCardapio();
    } else {
        renderGrid();
    }
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

// ── CARDÁPIO ADMIN ────────────────────────────────────────────────────────
let cardapio       = [];
let itemEditandoId = null;

const categoriasLabel = { marmitex:'🍱 Marmitex', bebida:'🥤 Bebidas', outro:'🍽️ Outros' };
const categoriasOrdem = ['marmitex', 'bebida', 'outro'];

async function carregarCardapio() {
    try {
        const snap = await getDocs(query(collection(db,'cardapio'), orderBy('categoria')));
        cardapio = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        renderCardapio();
    } catch(e) { console.error(e); }
}

function renderCardapio() {
    const grid = document.getElementById('grid-pedidos');

    const grupos = {};
    cardapio.forEach(item => {
        if (!grupos[item.categoria]) grupos[item.categoria] = [];
        grupos[item.categoria].push(item);
    });

    const semItens = cardapio.length === 0
        ? '<p class="cardapio-vazio">Nenhum item cadastrado ainda. Clique em "+ Novo item" para começar.</p>'
        : '';

    grid.innerHTML = `
        <div class="cardapio-wrap">
            <div class="cardapio-header">
                <h3>Itens do cardápio</h3>
                <button class="btn-novo-item" onclick="abrirModalItem()">+ Novo item</button>
            </div>
            ${semItens}
            ${categoriasOrdem.filter(c => grupos[c]).map(cat => `
                <div class="categoria-bloco">
                    <h4>${categoriasLabel[cat]}</h4>
                    ${grupos[cat].map(item => `
                        <div class="card-cardapio">
                            <div class="card-cardapio-info">
                                <div class="card-cardapio-nome">${item.nome}</div>
                                ${item.descricao ? `<div class="card-cardapio-desc">${item.descricao}</div>` : ''}
                            </div>
                            <span class="card-cardapio-preco">R$ ${Number(item.preco).toFixed(2).replace('.',',')}</span>
                            <div class="card-cardapio-acoes">
                                <button class="btn-editar"  onclick="editarItem('${item._id}')">✏️ Editar</button>
                                <button class="btn-excluir" onclick="excluirItem('${item._id}')">🗑️ Excluir</button>
                            </div>
                        </div>`).join('')}
                </div>`).join('')}
        </div>`;
}

window.abrirModalItem = () => {
    itemEditandoId = null;
    document.getElementById('modal-item-titulo').textContent = 'Novo item';
    document.getElementById('item-nome').value       = '';
    document.getElementById('item-desc').value       = '';
    document.getElementById('item-preco').value      = '';
    document.getElementById('item-categoria').value  = 'marmitex';
    document.getElementById('erro-item').textContent = '';
    document.getElementById('modalItem').classList.add('open');
};

window.editarItem = (id) => {
    const item = cardapio.find(c => c._id === id);
    if (!item) return;
    itemEditandoId = id;
    document.getElementById('modal-item-titulo').textContent = 'Editar item';
    document.getElementById('item-nome').value       = item.nome;
    document.getElementById('item-desc').value       = item.descricao || '';
    document.getElementById('item-preco').value      = item.preco;
    document.getElementById('item-categoria').value  = item.categoria;
    document.getElementById('erro-item').textContent = '';
    document.getElementById('modalItem').classList.add('open');
};

window.fecharModalItem = () => document.getElementById('modalItem').classList.remove('open');

window.salvarItem = async () => {
    const nome      = document.getElementById('item-nome').value.trim();
    const descricao = document.getElementById('item-desc').value.trim();
    const preco     = parseFloat(document.getElementById('item-preco').value);
    const categoria = document.getElementById('item-categoria').value;
    const erro      = document.getElementById('erro-item');

    if (!nome)                  { erro.textContent = 'Informe o nome do item.'; return; }
    if (isNaN(preco) || preco <= 0) { erro.textContent = 'Informe um preço válido.'; return; }

    try {
        if (itemEditandoId) {
            await updateDoc(doc(db,'cardapio',itemEditandoId), { nome, descricao, preco, categoria });
        } else {
            await addDoc(collection(db,'cardapio'), { nome, descricao, preco, categoria, criadoEm: serverTimestamp() });
        }
        fecharModalItem();
        carregarCardapio();
        showNotif(itemEditandoId ? 'Item atualizado ✓' : 'Item adicionado ✓', nome);
    } catch(e) {
        erro.textContent = 'Erro ao salvar. Tente novamente.';
        console.error(e);
    }
};

window.excluirItem = async (id) => {
    if (!confirm('Excluir este item do cardápio?')) return;
    try {
        await deleteDoc(doc(db,'cardapio', id));
        carregarCardapio();
        showNotif('Item removido ✓', '');
    } catch(e) { showNotif('Erro ao excluir', 'Tente novamente.'); console.error(e); }
};