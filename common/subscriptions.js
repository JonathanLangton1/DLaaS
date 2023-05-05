/**
 * @fileoverview A module for managing subscriptions and invoices. It provides functions to create, renew,
 * and terminate subscriptions, create invoices, confirm payments, and check subscription expiration.
 * The module also sends emails to users for various events, such as subscription expiration or invoice creation.
 */
const { getConfigurationFile } = require("./config-utils");
const { sendEmail } = require("./email-utils");
const { getUserBy, dbQuery } = require("./database-utils");
const { sendChiaRPCCommand } = require("./worker-bridge");
const rpc = require("./rpc.json");
const { v4: uuidv4 } = require("uuid");

/**
 * Creates a new subscription for a user and sends an email with the invoice.
 *
 * @async
 * @param {number} userId - The user ID for which the subscription is being created.
 * @param {string} productKey - The product key associated with the subscription.
 * @returns {Promise<number>} A promise that resolves with the subscription ID or rejects with an error.
 */
async function createSubscription(userId, productKey, data) {
  return new Promise(async (resolve, reject) => {
    // Set the subscription start and end dates
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setFullYear(startDate.getFullYear() + 1);

    // Load the products configuration
    const productsConfig = await getConfigurationFile("products.config.json");
    const product = productsConfig[productKey];

    if (!product) {
      reject(new Error("Product not found."));
      return;
    }

    // Insert the new subscription into the database
    const queryString = `
      INSERT INTO subscriptions (user_id, product_key, start_date, end_date, status, data)
      VALUES (:userId, :productKey, :startDate, :endDate, 'pending', :data);
    `;
    const queryValues = {
      userId,
      productKey,
      startDate,
      endDate,
      data: JSON.stringify({
        cmd: product.cmd,
        data: {
          userId,
          ...data,
        },
      }),
    };

    try {
      const result = await dbQuery(queryString, queryValues);
      const subscriptionId = result.insertId;
      console.log(`Subscription created with ID: ${subscriptionId}`);

      try {
        // Create the invoice for the new subscription
        await createInvoice(userId, subscriptionId, product);

        console.log(`Invoice email sent to user ID: ${userId}`);
        resolve(subscriptionId);
      } catch (error) {
        console.error("Error creating invoice or sending email:", error);
        reject(error);
      }
    } catch (error) {
      console.error("Error creating subscription:", error);
      reject(error);
    }
  });
}

/**
 * Creates a new invoice for a subscription and sends an email with the invoice.
 *
 * @async
 * @param {number} userId - The user ID for which the subscription is being created.
 * @param {number} subscriptionId - The subscription ID for which the invoice is being created.
 * @param {Object} product - The product object containing the product's details.
 * @param {string} product.id - The product ID.
 * @param {string} product.name - The product name.
 * @param {string} product.description - The product description.
 * @param {number} product.cost - The product cost.
 * @returns {Promise<Object>} A promise that resolves with the invoice object or rejects with an error.
 */
async function createInvoice(userId, subscriptionId, product) {
  return new Promise(async (resolve, reject) => {
    // Set the invoice issue date
    const issueDate = new Date();

    // Set the due date to one year in the future
    const dueDate = new Date(issueDate);
    dueDate.setFullYear(issueDate.getFullYear() + 1);

    // Get the cost from the product object
    const amount = product.cost;

    // Send a command to your Chia node to retrieve a new payment address
    const xchPaymentAddress = (
      await sendChiaRPCCommand(rpc.GET_NEW_PAYMENT_ADDRESS)
    )?.result;

    if (!xchPaymentAddress) {
      throw new Error("Error retrieving payment address from Chia node.");
    }

    const invoiceId = uuidv4();

    // Insert the new invoice into the database
    const queryString = `
      INSERT INTO invoices (guid, subscription_id, issue_date, due_date, total_amount_due, xch_payment_address, status)
      VALUES (:guid, :subscriptionId, :issueDate, :dueDate, :amount, :xchPaymentAddress, 'unpaid');
    `;
    const queryValues = {
      guid: invoiceId,
      subscriptionId,
      issueDate,
      dueDate,
      amount,
      xchPaymentAddress,
    };

    try {
      await dbQuery(queryString, queryValues);
      console.log(`Invoice created with ID: ${invoiceId}`);

      // Get the user's email address from the subscription
      const user = await getUserBy("id", userId);

      // Get the service domain from the app.config.json file
      const appConfig = await getConfigurationFile("app.config.json");
      const serviceDomain = appConfig.SERVICE_DOMAIN;

      // Send the invoice email to the user
      const invoiceUrl = `https://app.${serviceDomain}/invoices/${invoiceId}`;
      await sendEmail(
        user.email,
        "Your Invoice",
        `Please pay the invoice at ${invoiceUrl} to activate or renew your subscription.`
      );
      console.log(`Invoice email sent to user: ${user.email}`);

      resolve({
        id: invoiceId,
        subscription_id: subscriptionId,
        issue_date: issueDate,
        due_date: dueDate,
        amount: amount,
        xch_payment_address: xchPaymentAddress,
        status: "unpaid",
      });
    } catch (error) {
      console.error("Error creating invoice or fetching invoice:", error);
      reject(error);
    }
  });
}

async function insertTransactionsAndCalculateSum(transactions, invoiceId) {
  let confirmedSum = 0;

  for (const transaction of transactions) {
    if (transaction.confirmed) {
      confirmedSum += transaction.amount / 1000000000000;

      const query = `
        INSERT IGNORE INTO payments (invoice_guid, coin_name, amount, confirmed_at_height, fee)
        VALUES (:invoice_guid, :coinName, :amount, :confirmedAtHeight, :fee)
      `;

      const values = {
        invoice_guid: invoiceId,
        coinName: transaction.name,
        amount: transaction.amount / 1000000000000,
        confirmedAtHeight: transaction.confirmed_at_height,
        fee: transaction.fee_amount,
      };

      await dbQuery(query, values);
    }
  }

  return confirmedSum;
}

async function checkForPayment(invoiceId) {
  return new Promise(async (resolve, reject) => {
    const getInvoiceQueryString = `
      SELECT * FROM invoices
      WHERE guid = :invoiceId;
    `;
    const getInvoiceQueryValues = {
      invoiceId,
    };

    try {
      const result = await dbQuery(
        getInvoiceQueryString,
        getInvoiceQueryValues
      );

      if (result.length === 0) {
        console.error("No invoice found with the provided GUID");
        reject(new Error("No invoice found with the provided GUID"));
        return;
      }

      const invoice = result[0];

      if (invoice.status === "paid") {
        console.log(`Invoice with GUID: ${invoiceId} is already paid.`);
        resolve(invoice);
        return;
      }

      const xchPaymentAddress = invoice.xch_payment_address;

      // Send a command to your Chia node to check for payments to the address
      const addressTransactions = (
        await sendChiaRPCCommand(rpc.GET_TRANSACTIONS, {
          address: xchPaymentAddress,
        })
      )?.result;

      if (!addressTransactions) {
        throw new Error(
          `Error retrieving transactions from Chia node. For ${xchPaymentAddress}`
        );
      }

      const totalXchPaid = await insertTransactionsAndCalculateSum(
        addressTransactions,
        invoiceId
      );

      if (!totalXchPaid) {
        throw new Error("Error retrieving balance from Chia node.");
      }

      await dbQuery(
        `UPDATE invoices SET amount_paid = :amount_paid WHERE guid = :invoiceId`,
        {
          amount_paid: totalXchPaid,
          invoiceId,
        }
      );

      // Check if the balance is greater than or equal to the invoice amount
      if (totalXchPaid >= invoice.total_amount_due) {
        try {
          // Mark the invoice as paid
          await confirmPayment(invoiceId);
          resolve(invoice);
        } catch (error) {
          reject(error);
        }
      } else {
        console.log(`Invoice with GUID: ${invoiceId} is not paid yet.`);
        resolve(invoice);
      }
    } catch (error) {
      console.error("Error fetching invoice:", error);
      reject(error);
    }
  });
}

// assumes that the payment
// verification with the Chia blockchain is done outside of this function.
async function confirmPayment(guid) {
  return new Promise(async (resolve, reject) => {
    const updateInvoiceQueryString = `
      UPDATE invoices
      SET status = 'paid'
      WHERE guid = :guid;
    `;
    const updateInvoiceQueryValues = {
      guid,
    };

    try {
      const result = await dbQuery(
        updateInvoiceQueryString,
        updateInvoiceQueryValues
      );

      if (result.affectedRows === 0) {
        console.error("No invoice found with the provided GUID");
        reject(new Error("No invoice found with the provided GUID"));
        return;
      }

      console.log(`Invoice with GUID: ${guid} marked as paid.`);

      const getSubscriptionQueryString = `
        SELECT s.* FROM subscriptions s
        JOIN invoices i ON s.id = i.subscription_id
        WHERE i.guid = :guid;
      `;
      const rows = await dbQuery(getSubscriptionQueryString, { guid });

      if (rows.length === 0) {
        console.error("Error fetching subscription.");
        reject(new Error("Subscription not found."));
      } else {
        const subscription = rows[0];

        const updateSubscriptionQueryString = `
          UPDATE subscriptions
          SET status = 'active'
          WHERE id = :subscriptionId;
        `;
        await dbQuery(updateSubscriptionQueryString, {
          subscriptionId: subscription.id,
        });

        const subscriptionData = JSON.parse(subscription.data);

        await sendChiaRPCCommand(
          rpc[subscriptionData.cmd],
          {
            subscriptionId: subscription.id,
            ...subscriptionData.data
          }
        );

        console.log(`Subscription ID: ${subscription.id} marked as active.`);
        resolve(subscription.id);
      }
    } catch (error) {
      console.error("Error updating invoice or subscription:", error);
      reject(error);
    }
  });
}

async function checkSubscriptionsForExpiration() {
  return new Promise(async (resolve, reject) => {
    const currentDate = new Date();
    const expirationDate = new Date(currentDate);
    expirationDate.setDate(currentDate.getDate() + 15);

    const queryString = `
      SELECT s.*, u.email FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      WHERE s.status = 'active' AND s.end_date BETWEEN :currentDate AND :expirationDate;
    `;
    const queryValues = {
      currentDate,
      expirationDate,
    };

    try {
      const appConfig = await getConfigurationFile("app.config.json");
      const rows = await dbQuery(queryString, queryValues);
      console.log(`Found ${rows.length} subscriptions expiring soon.`);

      const invoicePromises = rows.map(async (subscription) => {
        try {
          const invoice = await createInvoice(subscription.id);
          const invoiceUrl = `https://app.${appConfig.serviceDomain}/invoices/${invoice.guid}`;

          await sendEmail(
            subscription.email,
            "Your Subscription Is Expiring Soon",
            `Your subscription is expiring soon. Please pay the invoice at ${invoiceUrl} to renew your subscription.`
          );

          console.log(`Invoice email sent to user ID: ${subscription.user_id}`);
        } catch (error) {
          console.error("Error creating invoice or sending email:", error);
        }
      });

      await Promise.all(invoicePromises);
      resolve();
    } catch (error) {
      console.error("Error fetching subscriptions:", error);
      reject(error);
    }
  });
}

async function renewSubscription(subscriptionId) {
  return new Promise(async (resolve, reject) => {
    const getSubscriptionQueryString = `
      SELECT * FROM subscriptions
      WHERE id = :subscriptionId;
    `;
    try {
      const rows = await dbQuery(getSubscriptionQueryString, {
        subscriptionId,
      });

      if (rows.length === 0) {
        console.error("Error fetching subscription");
        reject(new Error("Subscription not found"));
        return;
      }

      const subscription = rows[0];

      if (subscription.status === "terminated") {
        console.error("Cannot renew a terminated subscription");
        reject(new Error("Cannot renew a terminated subscription"));
        return;
      }

      const newEndDate = new Date(subscription.end_date);
      newEndDate.setFullYear(newEndDate.getFullYear() + 1);

      const updateSubscriptionQueryString = `
        UPDATE subscriptions
        SET end_date = :newEndDate
        WHERE id = :subscriptionId;
      `;
      await dbQuery(updateSubscriptionQueryString, {
        newEndDate,
        subscriptionId,
      });

      console.log(`Subscription ID: ${subscriptionId} renewed.`);
      resolve({
        ...subscription,
        end_date: newEndDate,
      });
    } catch (error) {
      console.error("Error renewing subscription:", error);
      reject(error);
    }
  });
}

async function terminateSubscription(subscriptionId) {
  try {
    const getSubscriptionQueryString = `
      SELECT * FROM subscriptions
      WHERE id = :subscriptionId;
    `;
    const rows = await dbQuery(getSubscriptionQueryString, { subscriptionId });

    if (rows.length === 0) {
      console.error("Error fetching subscription: not found");
      throw new Error("Subscription not found");
    }

    const subscription = rows[0];

    const updateSubscriptionQueryString = `
      UPDATE subscriptions
      SET status = 'terminated'
      WHERE id = :subscriptionId;
    `;

    await dbQuery(updateSubscriptionQueryString, { subscriptionId });

    console.log(`Subscription ID: ${subscriptionId} terminated.`);
    return {
      ...subscription,
      status: "terminated",
    };
  } catch (error) {
    console.error("Error in terminateSubscription:", error);
    throw error;
  }
}

async function setSubscriptionsToGracePeriod() {
  return new Promise(async (resolve, reject) => {
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);

    const queryString = `
      SELECT s.*, u.email FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      WHERE s.status = 'active' AND s.end_date = :currentDate;
    `;

    try {
      const rows = await dbQuery(queryString, { currentDate });

      console.log(`Found ${rows.length} subscriptions that expired today.`);

      if (rows.length === 0) {
        resolve(0);
        return;
      }

      const updateSubscriptionQueryString = `
        UPDATE subscriptions
        SET status = 'grace_period'
        WHERE id IN (:subscriptionIds);
      `;
      const subscriptionIds = rows.map((subscription) => subscription.id);

      const result = await dbQuery(updateSubscriptionQueryString, {
        subscriptionIds,
      });

      console.log(`${result.affectedRows} subscriptions set to grace_period.`);

      // Send emails to users
      const emailPromises = rows.map(async (subscription) => {
        try {
          await sendEmail(
            subscription.email,
            "Your Subscription Has Expired",
            `Your subscription has expired. You have a grace period of ${15} days to renew your subscription.`
          );

          console.log(
            `Grace period email sent to user ID: ${subscription.user_id}`
          );
        } catch (error) {
          console.error("Error sending grace period email:", error);
        }
      });

      await Promise.all(emailPromises);
      resolve(result.affectedRows);
    } catch (error) {
      console.error("Error fetching subscriptions:", error);
      reject(error);
    }
  });
}

module.exports = {
  createSubscription,
  createInvoice,
  confirmPayment,
  checkSubscriptionsForExpiration,
  renewSubscription,
  terminateSubscription,
  setSubscriptionsToGracePeriod,
  checkForPayment,
};
