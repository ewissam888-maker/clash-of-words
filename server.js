const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const { debug } = require('console');
const { deserialize } = require('v8');
const fs = require('fs');
const dotenv = require("dotenv")
dotenv.config()
console.log("Clé détectée :", process.env.API_GEMINI);

// ══ CONNEXION BASE DE DONNÉES ══
const db = mysql.createPool({
  host: "mysql-clashofwords.alwaysdata.net",
  user: "clashofwords",
  password: "Wissam20052006",
  database: "clashofwords_bdd"
});

// ══ SERVEUR ══
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ══ JOUEURS CONNECTÉS ══
const joueurs = {};
const parties = {};
const parties_invit = {};
const joueurs_en_recherche = [];
const disconnectTimers = {};
io.on('connection', (socket) => {
  console.log('✅ Joueur connecté :', socket.id);

  // ── Rejoindre ──
  socket.on('rejoindre', (nom) => {

    if (disconnectTimers[nom]) {
      clearTimeout(disconnectTimers[nom]);
      delete disconnectTimers[nom];
      console.log(`⏪ ${nom} revenu avant timeout`);
    }

    joueurs[socket.id] = { nom, socket };
    console.log(`👤 ${nom} a rejoint le jeu`);

    socket.emit('maj_enligne', {
      nb_enligne: Object.keys(joueurs).length,
      nb_recherche: joueurs_en_recherche.length
    });

    socket.broadcast.emit('maj_enligne', {
      nb_enligne: Object.keys(joueurs).length,
      nb_recherche: joueurs_en_recherche.length
    });

    // Amis connectés
    db.query(
      `SELECT * FROM amis WHERE joueur1 = ? OR joueur2 = ?`,
      [nom, nom],
      (err, amis) => {
        if (err) return console.error(err);
        const nomsAmis = amis.map(a => a.joueur1 === nom ? a.joueur2 : a.joueur1);

        const dejaConnectes = Object.values(joueurs)
          .filter(j => j.nom !== nom && nomsAmis.includes(j.nom))
          .map(j => j.nom);
        if (dejaConnectes.length) socket.emit('joueur_en_ligne', dejaConnectes);

        Object.values(joueurs).forEach(j => {
          if (nomsAmis.includes(j.nom)) {
            j.socket.emit('joueur_en_ligne', [nom]);
          }
        });
      }


    );

    // Amis hors-ligne
    db.query(
      'SELECT * FROM amis WHERE joueur1 = ? OR joueur2 = ?',
      [nom, nom],
      (err, amis) => {
        if (err) return console.error(err);
        const nomsAmis = amis.map(a => a.joueur1 === nom ? a.joueur2 : a.joueur1);
        const joueurs_co = Object.values(joueurs).map(j => j.nom);
        const joueurs_hl = nomsAmis.filter(j => !joueurs_co.includes(j));
        socket.emit('joueur_hors_ligne', joueurs_hl);
      }
    );

    // Demandes en attente
    db.query(
      'SELECT * FROM demandes_amis WHERE destinataire = ? AND statut = "en_attente"',
      [nom],
      (err, results) => {
        if (err) return console.error(err);
        results.forEach(demande => {
          socket.emit('demande_ami_recue', { de: demande.expediteur, a: demande.destinataire });
        });
      }
    );



    Object.values(parties).forEach(partie => {
      if (partie.par?.pseudo === nom) {
        partie.par.socketId = socket.id;
        console.log(`🔄 Socket mis à jour pour ${nom} (par)`);
      }
      if (partie.contre?.pseudo === nom) {
        partie.contre.socketId = socket.id;
        console.log(`🔄 Socket mis à jour pour ${nom} (contre)`);
      }
    });

  });

  // ── Rechercher un joueur ──
  socket.on('recherche', (nom) => {
    db.query(
      'SELECT * FROM comptes WHERE Pseudo = ?',
      [nom],
      (err, result) => {
        if (err) return console.error('Erreur BDD (recherche) :', err);
        socket.emit('res_recherche', result[0] || null, nom);
      }
    );
  });

  // ── Envoyer une demande d'ami ──
  socket.on('demande_ami', (data) => {
    db.query(
      `SELECT * FROM amis 
       WHERE (joueur1 = ? AND joueur2 = ?)
          OR (joueur1 = ? AND joueur2 = ?)`,
      [data.expediteur, data.destinataire, data.destinataire, data.expediteur],
      (err, result) => {
        if (err) return console.error(err);
        if (result.length > 0) {
          socket.emit('demande_ami_erreur', { message: `${data.destinataire} est déjà votre ami` });
          return;
        }

        db.query(
          'SELECT * FROM demandes_amis WHERE expediteur = ? AND destinataire = ? AND statut = "en_attente"',
          [data.expediteur, data.destinataire],
          (err, result) => {
            if (err) return console.error(err);
            if (result.length > 0) {
              socket.emit('demande_ami_erreur', { message: 'Demande déjà envoyée !' });
              return;
            }

            db.query(
              'INSERT INTO demandes_amis (expediteur, destinataire, statut) VALUES (?, ?, "en_attente")',
              [data.expediteur, data.destinataire],
              (err) => {
                if (err) return console.error(err);

                console.log(`✅ Demande envoyée de ${data.expediteur} à ${data.destinataire}`);
                socket.emit('demande_ami_ok', { message: `Demande envoyée à ${data.destinataire} !` });

                const cible = Object.values(joueurs).find(j => j.nom === data.destinataire);
                if (cible) cible.socket.emit('demande_ami_recue', { de: data.expediteur });
              }
            );
          }
        );
      }
    );
  });

  // ── Accepter une demande d'ami ──
  socket.on('accepter_ami', (data) => {
    db.query(
      'UPDATE demandes_amis SET statut = "accepte" WHERE expediteur = ? AND destinataire = ?',
      [data.expediteur, data.destinataire],
      (err) => {
        if (err) return console.error('Erreur BDD (accepter) :', err);

        db.query(
          'INSERT INTO amis (joueur1, joueur2) VALUES (?, ?)',
          [data.expediteur, data.destinataire],
          (err) => {
            if (err) return console.error('Erreur BDD (insertion ami) :', err);

            console.log(`✅ ${data.expediteur} et ${data.destinataire} sont maintenant amis`);
            socket.emit('ami_accepte', { ami: data.expediteur });

            const cible = Object.values(joueurs).find(j => j.nom === data.expediteur);
            if (cible) {
              cible.socket.emit('ami_accepte_notif', { ami: data.destinataire });
              cible.socket.emit('joueur_en_ligne', [data.destinataire]);  // l'expéditeur voit le destinataire en ligne
              socket.emit('joueur_en_ligne', [data.expediteur]);
            }
            else {
              socket.emit('joueur_en_ligne', []);
            }


          }
        );
      }
    );
  });

  // ── Refuser une demande d'ami ──
  socket.on('refuser_ami', (data) => {
    db.query(
      'UPDATE demandes_amis SET statut = "refuse" WHERE expediteur = ? AND destinataire = ?',
      [data.expediteur, data.destinataire],
      (err) => {
        if (err) return console.error('Erreur BDD (refuser) :', err);

        console.log(`❌ ${data.destinataire} a refusé la demande de ${data.expediteur}`);

        Object.values(joueurs).filter(j => {
          if (j.nom == data.expediteur) {
            j.socket.emit('ami_refuse', data.destinataire);
          }
        });
      }
    );
  });

  // ── Déconnexion ──
  socket.on('disconnect', () => {
    const joueur = joueurs[socket.id];
    Object.keys(parties).forEach(id => {
      let partie = parties[id];
      if (partie.statut === "EnCours") {
        if (partie.par.pseudo === joueur.nom || partie.contre.pseudo === joueur.nom) {

          let adv = (partie.par.pseudo === joueur.nom) ? partie.contre.pseudo : partie.par.pseudo
          Object.keys(joueurs).forEach(socketID => {
            let _joueur = joueurs[socketID];
            if (_joueur.nom === adv) {
              let _socket = _joueur.socket;
              let _score = partie.etat[adv].score + 20;
              let _mot = partie.mot;
              _socket.emit("abandon_joueur", { abandon: joueur.nom, score: _score, mot: _mot });
              db.query(
                'INSERT INTO historique VALUES (?,?,?,?,?,?,?,?,?)',
                [id, joueur.nom, adv, adv, _mot, "Abandon", "-", partie.etat[joueur.nom].score, _score],
                (err) => {
                  if (err) return console.error('Erreur BDD (refuser) :', err);

                  console.log(`📝 Partie ajoutée a l'historique`);
                }
              );
            }
          })
          console.log("Le joueur ", joueur.nom, "était en partie.\n", adv, " a donc gagné par forfait");
          delete parties[id];
          console.log("Suppression de la partie", parties);


        }
      }

    })

    if (!joueur) return;

    console.log(`⏳ ${joueur.nom} déconnecté, attente 5s...`);
    const nom = joueur.nom;

    // On supprime uniquement l'ancien socket
    delete joueurs[socket.id];

    socket.broadcast.emit('maj_enligne', {
      nb_enligne: Object.keys(joueurs).length,
      nb_recherche: joueurs_en_recherche.length
    });

    // ✅ CORRECTION 1 : Nettoyer un éventuel timer fantôme pour éviter les exécutions multiples
    if (disconnectTimers[nom]) {
      clearTimeout(disconnectTimers[nom]);
    }

    disconnectTimers[nom] = setTimeout(() => {
      delete disconnectTimers[nom];

      // ✅ CORRECTION 2 : Vérifier si le joueur s'est reconnecté entre-temps sur un nouveau socket
      // (Règle le bug du joueur qui passe hors-ligne après un changement de page)
      const estTjsEnLigne = Object.values(joueurs).some(j => j.nom === nom);
      if (estTjsEnLigne) {
        console.log(`🔄 ${nom} est toujours en ligne via un nouveau socket, annulation du hors-ligne.`);
        return;
      }

      // ✅ CORRECTION 3 : Sécuriser la recherche en partie (cas où p.par est une simple string dans le lobby)
      const enPartie = Object.values(parties).find(p =>
        (
          p.par === nom || p.contre === nom ||
          p.par?.pseudo === nom || p.contre?.pseudo === nom
        ) &&
        p.statut !== 'Terminee'
      );

      if (enPartie) {
        console.log(`🎮 ${nom} en partie active, pas de notification offline`);
        return;
      }

      console.log(`👋 ${nom} définitivement déconnecté`);

      // Avertir les amis
      db.query(
        `SELECT * FROM amis WHERE joueur1 = ? OR joueur2 = ?`,
        [nom, nom],
        (err, amis) => {
          if (err) return console.error(err);
          const nomsAmis = amis.map(a => a.joueur1 === nom ? a.joueur2 : a.joueur1);
          Object.values(joueurs).forEach(j => {
            if (nomsAmis.includes(j.nom)) {
              j.socket.emit('joueur_hors_ligne', [nom]);
            }
          });
        }
      );
    }, 5000);
  });


  socket.on('creation_partie', (data) => { // stockage temporaire pour retrouver la partie 
    parties[data.code] = {
      salle: data.nom_salle,
      par: data.par
    }
    console.log("Parties existantes : ", parties);
  });


  socket.on('rejoindre_partie', (data) => {

    if (data.code in parties) {
      const createur = parties[data.code].par; // recup le nom du createur
      const cible = Object.values(joueurs).find(j => j.nom === createur); // recup nom/socket
      const rejoignant = Object.values(joueurs).find(j => j.nom === data.par);
      console.log("Partie trouvé, code : ", data.code, ", crée par : ", createur);
      socket.emit('feedback_partie_trouve', data.par)
      if (cible) cible.socket.emit('partie_trouve', data.par)



      const idPartie = `partie_${Date.now()}`;
      parties[idPartie] = {
        salle: data.code,
        par: { pseudo: cible.nom, socketId: cible.socket.id },
        contre: { pseudo: rejoignant.nom, socketId: rejoignant.socket.id },
        statut: "EnAttente",
        Depuis: "Par_Code",
        pret: []
      }

      delete parties[data.code];

      console.log("Partie crée :", parties[idPartie], "avec id :", idPartie);

      // Les faire rejoindre la même "room" Socket.io
      cible.socket.join(idPartie);
      rejoignant.socket.join(idPartie);


      // Notifier les deux joueurs
      io.to(idPartie).emit('lancer_parCode', {});

    }
    else {
      console.log("Aucune partie, code : ", data.code);
      socket.emit('feedback_partie_nul', (data.par));
      return;
    }







  })


  socket.on('recherche_joueur', (data) => {
    // Éviter les doublons

    const dejaDedans = joueurs_en_recherche.find(j => j.socketId === socket.id);
    if (dejaDedans) return;

    joueurs_en_recherche.push({ pseudo: data, socketId: socket.id });


    socket.emit('maj_enligne', {
      nb_enligne: Object.keys(joueurs).length,
      nb_recherche: joueurs_en_recherche.length - 1  // ✅ toi exclu
    });

    // Les autres → ils voient le vrai compteur
    socket.broadcast.emit('maj_enligne', {
      nb_enligne: Object.keys(joueurs).length,
      nb_recherche: joueurs_en_recherche.length      // ✅ toi inclus pour eux
    });


    console.log(`${data} cherche une partie...`);
    console.log("Joueurs en recherche : ", joueurs_en_recherche);

    // Dès qu'on a 2 joueurs, on les associe
    if (joueurs_en_recherche.length >= 2) {
      const joueur1 = joueurs_en_recherche.shift(); // retire le 1er
      const joueur2 = joueurs_en_recherche.shift(); // retire le 2ème
      socket.emit('maj_enligne', {
        nb_enligne: Object.keys(joueurs).length,
        nb_recherche: joueurs_en_recherche.length - 1  // ✅ toi exclu
      });

      // Les autres → ils voient le vrai compteur
      socket.broadcast.emit('maj_enligne', {
        nb_enligne: Object.keys(joueurs).length,
        nb_recherche: joueurs_en_recherche.length      // ✅ toi inclus pour eux
      });
      const idPartie = `partie_${Date.now()}`;
      parties[idPartie] = {
        salle: undefined,
        par: joueur1,
        contre: joueur2,
        statut: "EnAttente",
        Depuis: "Recherche",
        pret: []
      }

      console.log("Partie crée :", parties[idPartie], "avec id :", idPartie);

      // Les faire rejoindre la même "room" Socket.io
      io.sockets.sockets.get(joueur1.socketId)?.join(idPartie);
      io.sockets.sockets.get(joueur2.socketId)?.join(idPartie);

      // Notifier les deux joueurs
      io.to(idPartie).emit('joueur_trouve', {
        idPartie,
        joueur1: joueur1.pseudo,
        joueur2: joueur2.pseudo,
      });






      console.log(`Partie créée : ${joueur1.pseudo} vs ${joueur2.pseudo}`);
    }
  })


  socket.on('annulerRecherche', (pseudo) => {
    const idx = joueurs_en_recherche.findIndex(j => j.pseudo === pseudo);

    if (idx !== -1) {
      joueurs_en_recherche.splice(idx, 1);  // supprime le joueur de la file
      console.log(`${pseudo} a annulé la recherche`);
      console.log("joueurs en recherche : ", joueurs_en_recherche);
      socket.broadcast.emit('maj_enligne', {
        nb_enligne: Object.keys(joueurs).length,
        nb_recherche: joueurs_en_recherche.length      // ✅ toi inclus pour eux
      });
    }


  });


  socket.on('annuler_partie', (data) => {
    delete parties[data.code]
  })


  socket.on('inviter_partie', (data) => {
    destinataire = Object.values(joueurs).find(j => j.nom === data.destinataire)

    if (destinataire) destinataire.socket.emit('invitation_ami', { de: data.de, destinataire: data.destinataire, code: data.code });

  })


  socket.on('invitation_pannel', (data) => {
    const destinataire = Object.values(joueurs).find(j => j.nom === data.qui) // inviter qui
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    parties_invit[code] = {
      salle: data.par,
      par: data.par,
      pour: data.qui
    }
    console.log("Parties existantes : ", parties_invit);
    if (destinataire) destinataire.socket.emit('invitation_ami_pannel', { de: data.par, destinataire: data.qui, code: code });
  })


  socket.on('invitation_reponse', (data) => {
    const inviteur = Object.values(joueurs).find(j => j.nom === data.inviteur);
    const Accepteur = Object.values(joueurs).find(j => j.nom === data.par);
    if (!inviteur) return;
    if (data.accepte) {
      inviteur.socket.emit('invitation_acceptee', { par: data.par });
      console.log("Duel accepté : ", inviteur, "VS", Accepteur);
      const idPartie = `partie_${Date.now()}`;
      parties[idPartie] = {
        salle: undefined,
        par: { pseudo: inviteur.nom, socketId: inviteur.socket.id },
        contre: { pseudo: Accepteur.nom, socketId: Accepteur.socket.id },
        statut: "EnAttente",
        Depuis: "Par_Invitation",
        pret: []
      }

      delete parties[data.code];
      console.log("parties dispo", parties)
      console.log("Partie crée :", parties[idPartie], "avec id :", idPartie);

      // Les faire rejoindre la même "room" Socket.io
      inviteur.socket.join(idPartie);
      Accepteur.socket.join(idPartie);


      // Notifier les deux joueurs
      io.to(idPartie).emit('lancer_parInvit', {});


    } else {
      inviteur.socket.emit('invitation_refusee', { de: data.inviteur, par: data.par });


      // si refus on supprime la partie
      console.log("Refus de la partie par ", data.par);
      const codeASupprimer = Object.keys(parties_invit).find(code =>
        parties_invit[code].par === data.inviteur
      );
      if (codeASupprimer) {
        delete parties_invit[codeASupprimer];
        console.log(`✅ Partie annulée pour le code : ${codeASupprimer}`);
      }

      console.log("Parties restantes :", parties_invit);
    }


  });


  socket.on('annuler_invitation', (data) => {
    // On cherche l'entrée dont la propriété 'par' correspond au pseudo
    console.log("Annulation de la partie par ", data.par);
    const codeASupprimer = Object.keys(parties_invit).find(code =>
      parties_invit[code].par === data.par
    );

    if (codeASupprimer) {
      delete parties_invit[codeASupprimer];
      console.log(`✅ Invitation annulée pour le code : ${codeASupprimer}`);
    }
    console.log("Parties restantes :", parties_invit);
  });



  socket.on('Recup_ID', (pseudo) => {

    const idPartie = Object.keys(parties).find(id =>
      parties[id].par.pseudo === pseudo || parties[id].contre.pseudo === pseudo
    );

    if (idPartie) {
      const partie = parties[idPartie];
      console.log("Partie recuperée :", partie, "avec id :", idPartie);
      socket.emit('preparation_partie', {
        code: idPartie,
        joueur1: partie.par.pseudo,
        joueur2: partie.contre.pseudo
      });
      console.log(`🚀 Lancement envoyé à ${pseudo}`);
    }
  });


  socket.on('Demande_Recup_Data', (data) => {
    const partie = parties[data.code];
    if (!partie) return;

    socket.join(data.code);
    console.log(data.pseudo, "a rejoint la room");

    // Compter combien sont dans la room
    if (!partie.pret.includes(data.pseudo)) partie.pret.push(data.pseudo);

    // Joueur 1 va chercher le mot
    if (partie.par.pseudo === data.pseudo) {
      io.to(partie.par.socketId).emit('Recup_Data', data);
    }


    if (partie.mot) {
      socket.emit('lancement', {
        code: data.code,
        longueur: partie.mot.length,
        joueur1: partie.par.pseudo,
        joueur2: partie.contre.pseudo
      });
    }

  });





  socket.on('demande_lancement', (data) => {

    console.log("Informations de la partie :", data);
    fs.readFile('mots.txt', 'utf8', (err, contenu) => {
      if (err) return console.error('Erreur lecture mots.txt :', err);

      const mots = contenu.split('\n').map(m => m.trim()).filter(m => m.length > 0);
      const mot = mots[Math.floor(Math.random() * mots.length)].toUpperCase();
      parties[data.code].mot = mot;
      parties[data.code].statut = "EnCours"
      parties[data.code].etat = {
        [parties[data.code].par.pseudo]: {
          lettres_essayees: [],
          nb_erreurs: 0,
          nb_trouves: 0,
          score: 0

        },
        [parties[data.code].contre.pseudo]: {
          lettres_essayees: [],
          nb_erreurs: 0,
          nb_trouves: 0,
          score: 0
        }
      };


      parties[data.code].chrono = setTimeout(() => {
        const partie = parties[data.code];
        if (!partie || !partie.etat) return;

        const p1 = partie.par.pseudo;
        const p2 = partie.contre.pseudo;
        const score1 = partie.etat[p1].score;
        const score2 = partie.etat[p2].score;
        const mot = partie.mot;

        io.to(partie.par.socketId).emit('fin_chrono', { mon_score: score1, adv_score: score2, mot });
        io.to(partie.contre.socketId).emit('fin_chrono', { mon_score: score2, adv_score: score1, mot });

        // ══ AJOUT : GESTION DE L'HISTORIQUE EN CAS DE TIMEOUT ══

        let vainqueur = null;
        let resultat = "Egalite";

        // Détermination du vainqueur selon le score
        if (score1 > score2) {
          vainqueur = p1;
          resultat = "Victoire";
        } else if (score2 > score1) {
          vainqueur = p2;
          resultat = "Victoire";
        } else {
          vainqueur = "Aucun"; // Tu peux mettre NULL si ta BDD l'autorise
        }

        // La durée est fixe ici, puisque c'est un timeout complet (ex: 120 secondes)
        const duree_partie = "2:00";

        db.query(
          'INSERT INTO historique VALUES (?,?,?,?,?,?,?,?,?)',
          [data.code, p1, p2, vainqueur, mot, resultat, duree_partie, score1, score2],
          (err) => {
            if (err) return console.error('Erreur BDD (historique timeout) :', err);
            console.log(`📝 Partie [Timeout] ajoutée à l'historique (${p1} vs ${p2})`);
          }
        );
        // ═══════════════════════════════════════════════════════

        delete parties[data.code];
      }, 120000);

      console.log("Etat de la partie :", parties[data.code]);
      io.to(data.code).emit('lancement', {
        code: data.code,
        longueur: mot.length,
        joueur1: parties[data.code].par.pseudo,
        joueur2: parties[data.code].contre.pseudo
      });
    })

  })



  socket.on('jouer_lettre', ({ code, pseudo, lettre, duree }) => {
    const partie = parties[code];
    if (!partie) return;
    console.log(code)

    const adv = pseudo === partie.par.pseudo ? partie.contre.pseudo : partie.par.pseudo;
    const etat = partie.etat[pseudo];
    lettre = lettre.toUpperCase();

    if (etat.lettres_essayees.includes(lettre)) return;
    etat.lettres_essayees.push(lettre);

    const bonne = partie.mot.includes(lettre);
    const count = partie.mot.split(lettre).length - 1;

    if (bonne) {
      console.log(pseudo, ": a trouve la lettre :", lettre)
      etat.nb_trouves += count;
      etat.score += 10 * count;
    }

    if (!bonne) {
      etat.nb_erreurs++;
      etat.score -= 5;
      console.log(pseudo, ": s'est trompe sur la lettre :", lettre)
    }

    const mot_affiche = partie.mot.split('').map(l =>
      etat.lettres_essayees.includes(l) ? l : '_'
    ).join(' ');

    const gagne = !mot_affiche.includes('_');
    const perdu = etat.nb_erreurs >= 6;
    const etat_adv = partie.etat[adv];
    if (gagne) {
      etat.score += 30;
      db.query(
        'INSERT INTO historique VALUES (?,?,?,?,?,?,?,?,?)',
        [code, pseudo, adv, pseudo, partie.mot, "Victoire", duree, etat.score, etat_adv.score],
        (err) => {
          if (err) return console.error('Erreur BDD (refuser) :', err);

          console.log(`📝 Partie ajoutée a l'historique`);
        }
      );


    }
    if (perdu) {
      partie.etat[adv].score += 30;
      db.query(
        'INSERT INTO historique VALUES (?,?,?,?,?,?,?,?,?)',
        [code, pseudo, adv, adv, partie.mot, "Defaite", duree, etat.score, etat_adv.score],
        (err) => {
          if (err) return console.error('Erreur BDD (refuser) :', err);

          console.log(`📝 Partie ajoutée a l'historique`);
        }
      );


    }
    // Mise à jour pour CE joueur uniquement
    socket.emit('maj_partie', {
      adv: adv,
      score: etat.score,
      lettre,
      mot_affiche,
      nb_erreurs: etat.nb_erreurs,
      bonne_lettre: bonne,
      fini: gagne || perdu,
      gagne,
      perdu,
      mot: (gagne || perdu) ? partie.mot : null
    });

    // Progression visible par l'adversaire
    const adversaireSocketId = pseudo === partie.par.pseudo
      ? partie.contre.socketId
      : partie.par.socketId;

    io.to(adversaireSocketId).emit('maj_adversaire', {
      pseudo: pseudo,
      nb_erreurs: etat.nb_erreurs,
      nb_trouves: etat.nb_trouves,
      adversaire_gagne: gagne,
      adversaire_perdu: perdu,
      mot: (gagne || perdu) ? partie.mot : null,
      score: partie.etat[adv].score
    });

    if (gagne || perdu) {
      clearTimeout(parties[code].chrono);
    }
  });


  socket.on('demande_quitter_partie', (pseudo) => {
    console.log(pseudo, "a quitte la partie");
    const IDpartie = Object.keys(parties).find(id =>
      parties[id].par.pseudo === pseudo
      ||
      parties[id].contre.pseudo === pseudo);
    console.log("Suppression de la partie:", IDpartie, "...");
    if (IDpartie) delete parties[IDpartie];
    console.log("Mise a jour", parties);
  })



  socket.on('Demande_definition', (mot) => {


    const API_Gemini = process.env.API_GEMINI;

    if (!API_Gemini) {
      console.error("❌ Erreur : La clé API_GEMINI est introuvable dans le .env");
      return;
    }

    const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_Gemini}`;


    const payload = {
      contents: [{
        parts: [{
          text: `Réponds uniquement en JSON avec les clés suivantes : 'definition', 'exemple', 'synonyme' pour le mot : ${mot}`
        }]
      }]
    };


    fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
      .then(response => response.json())
      .then(data => {
        console.log(API_Gemini);
        console.log(process.env.API_GEMINI);
        if (data.error) console.log("⚠️ Google Gemini est surchargé :", data.error.message);
        const definitionBrute = data.candidates[0].content.parts[0].text;
        const clean = definitionBrute
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();

        const details = JSON.parse(clean);




        //socket.emit('afficher_definition', { mot: mot, def: definition });
      })
  })









}); // fin io.on('connection')

// ══ LANCER LE SERVEUR ══
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});



// lorsque deux joueurs dans une partie les supprimer des listes/dictionnaires
// gerer erreur : deuxieme code souvent chaine
// gerer indication erreur en haut page online.html
// sauvegarder game BDD
// cree historique
// bouton rejoindre (revanche) quand game termine
// parametres
// Tout reagencer

