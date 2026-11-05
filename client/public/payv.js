/*
 * PayV in the browser.
 *
 *   1. Connect the wallet the merchant will pay from.
 *   2. Ask Kora (which asks INFRA) for a price for THAT wallet. If Kora needs
 *      the merchant's own wallet and this one isn't linked, INFRA says so now,
 *      before anything is signed: link it, then ask again.
 *   3. Sign an x402 "exact" payment: an EIP-3009 TransferWithAuthorization for
 *      exactly the quoted amount to the quoted address. The facilitator pays
 *      gas, so the person only signs. No library needed: eth_signTypedData_v4
 *      on the injected wallet (MetaMask, Coinbase Wallet...).
 */
(function () {
  var root = document.getElementById('payv');
  if (!root) return;

  var base = root.dataset.baseUrl;
  var statusEl = document.getElementById('payv-status');
  var connectBtn = document.getElementById('connect-wallet');
  var payBtn = document.getElementById('pay');
  var linkStep = document.getElementById('step-link');
  var linkBtn = document.getElementById('link');
  var walletLine = document.getElementById('wallet-line');
  var priceLine = document.getElementById('price-line');
  var stepWallet = document.getElementById('step-wallet');
  var stepPay = document.getElementById('step-pay');

  var NETWORKS = {
    'base-sepolia': { chainId: 84532, name: 'Base Sepolia', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', usdc: { name: 'USDC', version: '2' } },
    base: { chainId: 8453, name: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', usdc: { name: 'USD Coin', version: '2' } },
  };
  var eth = window.ethereum;
  var account = null;
  var req = null;   // INFRA's payment requirements for this wallet
  var net = null;

  function say(text, kind) {
    statusEl.className = 'notice ' + (kind || 'info');
    statusEl.textContent = text;
  }
  function busy(btn, on, label) {
    btn.disabled = on;
    if (label) btn.textContent = label;
  }
  function hex(bytes) {
    return '0x' + Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function send(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return { ok: false, message: 'Kora sent an unexpected reply. Try again.' }; }); });
  }
  function walletError(err) {
    if (err && err.code === 4001) return 'You cancelled in your wallet. Nothing was charged.';
    return (err && err.message) ? 'Your wallet said: ' + err.message : 'Your wallet ran into a problem. Try again.';
  }
  function short(a) { return a.slice(0, 6) + '…' + a.slice(-4); }

  if (!eth) {
    say("No wallet found. Open this page in your wallet's browser (MetaMask, Coinbase Wallet, Rainbow) or install a wallet extension.", 'warn');
    connectBtn.disabled = true;
    return;
  }

  function switchNetwork() {
    var chainHex = '0x' + net.chainId.toString(16);
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] }).catch(function (err) {
      if (err && err.code !== 4902) throw err;
      return eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chainHex,
          chainName: net.name,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [net.rpc],
          blockExplorerUrls: [net.explorer],
        }],
      });
    });
  }

  // Step 2: ask for a price for this wallet.
  function getQuote() {
    say('Asking INFRA for the price for this wallet…', 'info');
    return send('POST', base + '/quote', { address: account }).then(function (res) {
      if (res.paid) { location.href = res.redirect; return; }
      if (res.ok) {
        req = res.requirements;
        net = NETWORKS[req.network];
        if (!net) { say('INFRA asked for payment on a network Kora does not know (' + req.network + ').', 'error'); return; }
        linkStep.hidden = true;
        document.getElementById('fact-amount').textContent = res.amount_display + ' ' + res.asset_symbol;
        document.getElementById('fact-network').textContent = net.name;
        document.getElementById('fact-payto').textContent = req.payTo;
        priceLine.textContent = res.amount_display + ' ' + res.asset_symbol + ' to ' + short(req.payTo) + ', from ' + short(account) + ' only.';
        stepPay.className = 'now';
        return switchNetwork().then(function () {
          payBtn.disabled = false;
          say('Ready. Your wallet will show the amount and the address it goes to. Check both before you sign.', 'info');
        });
      }
      if (res.code === 'PAYER_NOT_LINKED') {
        linkStep.hidden = false;
        linkStep.className = 'now';
        say(res.message, 'warn');
        return;
      }
      say(res.message || "INFRA couldn't price this. Please try again.", 'error');
    });
  }

  // MetaMask only shows this site the accounts you connected to it. If you
  // switch to one of them, Kora follows: the price is bound to one wallet, so
  // it asks INFRA again for the new one. (Switching to an account you never
  // connected changes nothing here: the site can't see it.)
  if (eth.on) {
    eth.on('accountsChanged', function (accounts) {
      var next = accounts && accounts[0];
      if (!account || !next || next.toLowerCase() === account.toLowerCase()) return;
      account = next;
      walletLine.textContent = 'Paying from ' + short(account);
      payBtn.disabled = true;
      say('You switched wallets. Getting a new price for ' + short(account) + '…', 'info');
      getQuote();
    });
  }

  connectBtn.addEventListener('click', function () {
    busy(connectBtn, true, 'Connecting…');
    eth.request({ method: 'eth_requestAccounts' })
      .then(function (accounts) {
        account = accounts[0];
        walletLine.textContent = 'Paying from ' + short(account) + '. To pay from another account, connect it to this site in your wallet first.';
        connectBtn.textContent = 'Connected';
        stepWallet.className = 'done';
        return getQuote();
      })
      .catch(function (err) {
        busy(connectBtn, false, 'Connect wallet');
        say(walletError(err), 'error');
      });
  });

  // Step 3: sign exactly what INFRA quoted.
  function signPayment() {
    var now = Math.floor(Date.now() / 1000);
    say('Your wallet will ask ' + short(account) + ' to sign: that is the wallet this price was made for.', 'info');
    var nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    var authorization = {
      from: account,
      to: req.payTo,
      value: String(req.maxAmountRequired),
      validAfter: String(now - 60),
      validBefore: String(now + Number(req.maxTimeoutSeconds || 300)),
      nonce: hex(nonce),
    };
    var domain = (req.extra && req.extra.name) ? { name: req.extra.name, version: req.extra.version || '2' } : net.usdc;
    var typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      domain: { name: domain.name, version: domain.version, chainId: net.chainId, verifyingContract: req.asset },
      message: authorization,
    };
    return eth.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typedData)] })
      .then(function (signature) {
        return btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: req.network, payload: { signature: signature, authorization: authorization } }));
      });
  }

  payBtn.addEventListener('click', function () {
    busy(payBtn, true, 'Waiting for your wallet…');
    signPayment()
      .then(function (xPayment) {
        say('Sending your payment to INFRA…', 'info');
        return send('POST', base, { x_payment: xPayment });
      })
      .then(function (res) {
        if (res.ok) {
          say('Paid. Your merchant badge is active.', 'ok');
          setTimeout(function () { location.href = res.redirect || '/merchant'; }, 900);
          return;
        }
        busy(payBtn, false, 'Sign and pay');
        if (res.code === 'PAYER_NOT_LINKED') {
          // The wallet was unlinked since the quote. Link again, then re-quote.
          payBtn.disabled = true;
          linkStep.hidden = false;
        }
        say(res.message || 'The payment did not go through. Nothing was charged.', res.code === 'PAYER_NOT_LINKED' ? 'warn' : 'error');
      })
      .catch(function (err) {
        busy(payBtn, false, 'Sign and pay');
        say(walletError(err), 'error');
      });
  });

  // Linking: prove the wallet (signature), then the person approves in INFRA.
  function utf8Hex(text) {
    return hex(new TextEncoder().encode(text));
  }

  function pollLink(challengeId, startedAt) {
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      say('The link request expired. Try linking again.', 'error');
      busy(linkBtn, false, 'Sign link message');
      return;
    }
    send('GET', base + '/wallet-link/' + encodeURIComponent(challengeId))
      .then(function (res) {
        if (res.ok && res.status === 'linked') {
          linkStep.className = 'done';
          busy(linkBtn, true, 'Linked');
          return getQuote();
        }
        if (res.ok && (res.status === 'denied' || res.status === 'expired')) {
          say(res.status === 'denied' ? 'The link was declined in INFRA. Nothing was charged.' : 'The link request expired. Try again.', 'error');
          busy(linkBtn, false, 'Sign link message');
          return;
        }
        setTimeout(function () { pollLink(challengeId, startedAt); }, 4000);
      })
      .catch(function () { setTimeout(function () { pollLink(challengeId, startedAt); }, 6000); });
  }

  linkBtn.addEventListener('click', function () {
    busy(linkBtn, true, 'Waiting for your wallet…');
    var challengeId;
    send('POST', base + '/wallet-link', { address: account })
      .then(function (res) {
        if (!res.ok) throw new Error(res.message);
        challengeId = res.challenge_id;
        return eth.request({ method: 'personal_sign', params: [utf8Hex(res.message), account] });
      })
      .then(function (signature) {
        return send('POST', base + '/wallet-link/' + encodeURIComponent(challengeId) + '/signature', { signature: signature });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.message);
        say('Now approve the link in the INFRA app. This page continues by itself.', 'info');
        busy(linkBtn, true, 'Waiting for your approval…');
        pollLink(challengeId, Date.now());
      })
      .catch(function (err) {
        busy(linkBtn, false, 'Sign link message');
        say(err && err.code ? walletError(err) : (err && err.message) || 'Linking failed. Try again.', 'error');
      });
  });
})();
