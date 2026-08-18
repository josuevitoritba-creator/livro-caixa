# Livro de Caixa

App para registrar valores de caixa, confirmar recebimento e fazer conferência periódica.

## Passo 1 — Criar o banco de dados (Firebase, gratuito)

1. Acesse https://console.firebase.google.com e faça login com sua conta Google.
2. Clique em **"Adicionar projeto"**, dê um nome (ex: `livro-caixa`) e siga o assistente (pode desativar o Google Analytics, não é necessário).
3. Dentro do projeto, no menu lateral, clique em **Build > Firestore Database**.
4. Clique em **"Criar banco de dados"**. Escolha a localização mais próxima (ex: `southamerica-east1`) e comece em **modo de teste** (depois vamos ajustar a regra de segurança).
5. Vá em **Regras** (aba dentro do Firestore) e cole o seguinte, depois clique em **Publicar**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```

   > Isso deixa o banco aberto para leitura/escrita por qualquer pessoa com o link do site — igual combinamos, sem login por convite. Se no futuro quiser travar mais, dá pra evoluir para regras com autenticação.

6. Volte para a página inicial do projeto (ícone de casinha), clique no ícone **`</>`** ("Adicionar app da Web").
7. Dê um apelido ao app (ex: `livro-caixa-web`) e clique em **"Registrar app"**.
8. Vai aparecer um bloco de código com `firebaseConfig = { apiKey: "...", authDomain: "...", ... }`. **Guarde esses valores**, você vai usá-los no Passo 3.

## Passo 2 — Subir o código para o GitHub

1. No seu computador (ou direto pelo site github.com), crie um repositório novo, por exemplo `livro-caixa`.
2. Baixe os arquivos deste projeto (o Claude vai te entregar a pasta/zip) e envie para esse repositório. Pelo terminal, dentro da pasta do projeto:

   ```bash
   git init
   git add .
   git commit -m "primeira versão do livro de caixa"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/livro-caixa.git
   git push -u origin main
   ```

   (Troque `SEU_USUARIO` pelo seu usuário do GitHub.)

## Passo 3 — Publicar na Vercel (gratuito)

1. Acesse https://vercel.com e faça login **com sua conta do GitHub**.
2. Clique em **"Add New" > "Project"**.
3. Selecione o repositório `livro-caixa` que você acabou de subir e clique em **"Import"**.
4. Em **"Environment Variables"**, adicione uma por uma as 6 variáveis abaixo, usando os valores que você guardou no Passo 1:

   | Nome | Valor |
   |---|---|
   | `VITE_FIREBASE_API_KEY` | valor de `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | valor de `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | valor de `projectId` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | valor de `storageBucket` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | valor de `messagingSenderId` |
   | `VITE_FIREBASE_APP_ID` | valor de `appId` |

5. Clique em **"Deploy"**. Em cerca de 1 minuto o site estará no ar, com um link tipo `https://livro-caixa-xxxx.vercel.app`.
6. Esse link pode ser acessado por qualquer pessoa, de qualquer dispositivo — é o link que você compartilha com os atendentes.

## Atualizações futuras

Sempre que quiser mudar algo no site, é só atualizar o código no GitHub (`git push`) — a Vercel publica a nova versão automaticamente em segundos.

## Rodando localmente (opcional, para testar antes de publicar)

```bash
npm install
cp .env.example .env.local   # depois preencha com suas chaves do Firebase
npm run dev
```
