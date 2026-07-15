function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) {
    return res.redirect('/login');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', {
      title: 'Acesso negado',
      message: 'Somente administradores podem acessar esta página.',
    });
  }
  next();
}

function requireSellerOrAdmin(req, res, next) {
  if (!req.session?.user) {
    return res.redirect('/login');
  }
  if (!['admin', 'seller'].includes(req.session.user.role)) {
    return res.status(403).render('error', {
      title: 'Acesso negado',
      message: 'Perfil sem permissão.',
    });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireSellerOrAdmin };
