const Fund = artifacts.require('./Fund.sol');
const NavCalculator = artifacts.require('./NavCalculator.sol');
const DataFeed = artifacts.require('./DataFeed.sol');

const { increaseTime, sendTransaction } = require('../js/helpers');

contract('NavCalculator', (accounts) => {
  let MANAGER = accounts[0];
  let EXCHANGE = accounts[1];
  const GAS_AMT = 500000;
  const MGMT_FEE_BPS = 100;
  const SECONDS_IN_YEAR = 31536000;
  const PERFORM_FEE_BPS = 2000;
  const TIMEDIFF = 50000;

  let fund, calculator, valueFeed;
  let totalSupply, totalEthPendingSubscription, totalEthPendingWithdrawal, navPerShare, accumulatedMgmtFees, accumulatedPerformFees, lossCarryforward;

  // Helpers
  const getBalInWei = address => parseInt(web3.eth.getBalance(address));
  const weiToNum = wei => web3.fromWei(wei, 'ether').toNumber();

  const changeExchangeValue = (_multiplier) => {
    return new Promise((resolve, reject) => {
      resolve(
        valueFeed.updateWithExchange(_multiplier)
          .then(() => valueFeed.value())
          .then((_val) => console.log("new exchange value:", weiToNum(_val)))
      );
    });
  };

  const retrieveFundParams = () => Promise.all([
    fund.lastCalcDate.call(),
    fund.navPerShare.call(),
    fund.lossCarryforward.call(),
    fund.accumulatedMgmtFees.call(),
    fund.accumulatedPerformFees.call()
  ]);

  const checkRoughEqual = (vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees) => {
    [ansNAV, ansLCF, ansAMF, ansAPF] = vals;
    assert(Math.abs(parseInt(navPerShare) / ansNAV - 1) < 0.0001, 'incorrect navPerShare');

    if (ansLCF !== 0) assert(Math.abs(parseInt(lossCarryforward) / ansLCF - 1) < 0.0001, 'incorrect lossCarryforward');
    else assert.equal(parseInt(lossCarryforward), 0, 'incorrect lossCarryforward');

    if (ansAMF !== 0) assert(Math.abs(parseInt(accumulatedMgmtFees) / ansAMF - 1) < 0.0001, 'incorrect accumulatedMgmtFees');
    else assert.equal(parseInt(accumulatedMgmtFees), 0, 'incorrect accumulatedMgmtFees');

    if (ansAPF !== 0) assert(Math.abs(parseInt(accumulatedPerformFees) / ansAPF - 1) < 0.0001, 'incorrect accumulatedPerformFees');
    else assert.equal(parseInt(accumulatedPerformFees), 0, 'incorrect accumulatedPerformFees');
  };

  const calc = (elapsedTime) => {
    return new Promise((resolve, reject) => {
      let fundBal, exchangeValue, ts;
      Promise.all([valueFeed.value(), getBalInWei(fund.address), fund.totalSupply()])
      .then((_vals) => {
        [exchangeValue, fundBal, ts] = _vals;
        let gav = parseInt(exchangeValue) + fundBal - totalEthPendingSubscription - totalEthPendingWithdrawal;
        // console.log('gav', gav);
        let nav = ts * navPerShare / 10000;
        // console.log('nav', nav);
        let mgmtFee = navPerShare * MGMT_FEE_BPS / 10000 * elapsedTime / SECONDS_IN_YEAR * ts / 10000;
        // console.log('mgmtFee', mgmtFee);
        let gpvlessFees = gav - accumulatedMgmtFees - accumulatedPerformFees;
        // console.log('gpvlessFees', gpvlessFees);
        let gainLoss = gpvlessFees - nav - mgmtFee;
        // console.log('gainLoss', gainLoss);
        let lossPayback = gainLoss > 0 ? Math.min(gainLoss, lossCarryforward) : 0;
        // console.log('lossPayback', lossPayback);
        let gainLossAfterPayback = gainLoss - lossPayback;
        // console.log('gainLossAfterPayback', gainLossAfterPayback);
        let performFee = gainLossAfterPayback > 0 ? gainLossAfterPayback * PERFORM_FEE_BPS / 10000 : 0;
        // console.log('performFee', performFee);
        let netGainLossAfterPerformFee = gainLossAfterPayback + lossPayback - performFee;
        // console.log('netGainLossAfterPerformFee', netGainLossAfterPerformFee);
        nav += netGainLossAfterPerformFee;
        if (netGainLossAfterPerformFee < 0) lossCarryforward += Math.abs(netGainLossAfterPerformFee);

        navPerShare = Math.trunc(nav * 10000 / totalSupply);
        lossCarryforward -= lossPayback;
        accumulatedMgmtFees += mgmtFee;
        accumulatedPerformFees += performFee;
        resolve([ navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees ]);
      }).catch(reject);
    });
  }

  before(() => {
    return Promise.all([Fund.deployed(), NavCalculator.deployed(), DataFeed.deployed()])
    .then(_values => {
      [fund, navCalculator, valueFeed] = _values;
      return navCalculator.setFund(fund.address)
    }).then(() => {
      return Promise.all([
        fund.totalSupply(),
        fund.totalEthPendingSubscription(),
        fund.totalEthPendingWithdrawal(),
        fund.accumulatedMgmtFees(),
        fund.accumulatedPerformFees(),
        fund.lossCarryforward()
      ]);
    }).then((_vals) => {
      [totalSupply, totalEthPendingSubscription, totalEthPendingWithdrawal,
      accumulatedMgmtFees, accumulatedPerformFees, lossCarryforward] = _vals.map(parseInt);
      totalEthPendingSubscription = totalEthPendingSubscription || 0;
      return fund.navPerShare();
    }).then((_navPerShare) => navPerShare = _navPerShare)
    .catch(console.error);
  });

  it('should set fund to the correct fund address', (done) => {
    navCalculator.setFund(fund.address)
    .then(() => {
      return navCalculator.fundAddress.call();
    }).then((_fund_addr) => {
      assert.equal(_fund_addr, fund.address, 'fund addresses don\'t match');
      done();
    });
  });

  it('should set value feed to the correct data feed address', (done) => {
    navCalculator.setValueFeed(valueFeed.address)
    .then(() => {
      return navCalculator.valueFeed.call()
    }).then((_val_addr) => {
      assert.equal(_val_addr, valueFeed.address, 'data feed addresses don\'t match');
      done();
    })
  });

  it('should calculate the navPerShare correctly (base case)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees;

    fund.lastCalcDate.call()
    .then(_date => date1 = _date)
    .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
    .then(() => fund.calcNav())
    .then(() => retrieveFundParams())
    .then((_values) => {
      [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees] = _values;
      assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
      return calc(date2 - date1);
    }).then((_vals) => {
      checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees);
      done();
    }).catch(console.error);
  });

  it('should calculate the navPerShare correctly (portfolio goes down)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees;

    Promise.resolve(changeExchangeValue(75))
    .then(() => fund.lastCalcDate.call())
    .then(_date => date1 = _date)
    .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
    .then(() => fund.calcNav())
    .then(() => retrieveFundParams())
    .then((_values) => {
      [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees] = _values;
      assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
      return calc(date2 - date1);
    }).then((_vals) => {
      checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees);
      done();
    }).catch(console.error);
  });


  it('should calculate the navPerShare correctly (portfolio recovers from loss)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees;

    Promise.resolve(changeExchangeValue(150))
    .then(() => fund.lastCalcDate.call())
    .then((_date) => date1 = _date)
    .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
    .then(() => fund.calcNav())
    .then(() => retrieveFundParams())
    .then((_values) => {
      [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees] = _values;
      assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
      return calc(date2 - date1);
    }).then((_vals) => {
      checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees);
      done();
    }).catch(console.error);
  });

  it('should calculate the navPerShare correctly (portfolio loses its gains)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees;

    Promise.resolve(changeExchangeValue(25))
    .then(() => fund.lastCalcDate.call())
    .then(_date => date1 = _date)
    .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
    .then(() => fund.calcNav())
    .then(() => retrieveFundParams())
    .then((_values) => {
      [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees] = _values;
      assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
      return calc(date2 - date1);
    }).then((_vals) => {
      checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees);
      done();
    }).catch(console.error);
  });

  it('should calculate the navPerShare correctly (portfolio goes up 50x)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees;

    Promise.resolve(changeExchangeValue(5000))
    .then(() => fund.lastCalcDate.call())
    .then(_date => date1 = _date)
    .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
    .then(() => fund.calcNav())
    .then(() => retrieveFundParams())
    .then((_values) => {
      [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees] = _values;
      assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
      return calc(date2 - date1);
    }).then((_vals) => {
      checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees);
      done();
    }).catch(console.error);
  });

  it('should calculate the navPerShare correctly (portfolio goes to 0)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees;

    Promise.resolve(changeExchangeValue(0))
    .then(() => fund.lastCalcDate.call())
    .then(_date => date1 = _date)
    .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
    .then(() => fund.calcNav())
    .then(() => retrieveFundParams())
    .then((_values) => {
      [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees] = _values;
      assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
      return calc(date2 - date1);
    }).then((_vals) => {
      checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedPerformFees);
      done();
    }).catch(console.error);
  });
});
